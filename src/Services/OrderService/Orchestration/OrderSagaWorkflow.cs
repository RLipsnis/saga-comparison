using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using OrderService.Domain;
using OrderService.Infrastructure;
using Shared.Contracts;
using Temporalio.Common;
using Temporalio.Workflows;

namespace OrderService.Orchestration;

[Workflow]
public class OrderSagaWorkflow
{
    // ── Activity retry configuration ──────────────────────────────────────
    // For fair benchmarking against MassTransit (which has no retries by default),
    // set MaximumAttempts = 1 below. For production-like behavior, use 3+.
    //
    // Normal activities: called during the happy path (reserve, pay, ship, notify)
    private static readonly ActivityOptions DefaultActivityOptions = new()
    {
        StartToCloseTimeout = TimeSpan.FromSeconds(30),
        RetryPolicy = new RetryPolicy
        {
            MaximumAttempts = 3,
            InitialInterval = TimeSpan.FromSeconds(1),
            BackoffCoefficient = 2.0f
        }
    };

    // Compensation activities: called during rollback (release, refund, cancel)
    // Uses fast-fail (1 attempt, short timeout) to match choreography behavior
    // in benchmark scenarios. In production, you'd want retries here too.
    private static readonly ActivityOptions CompensationActivityOptions = new()
    {
        StartToCloseTimeout = TimeSpan.FromSeconds(10),
        RetryPolicy = new RetryPolicy
        {
            MaximumAttempts = 1
        }
    };

    [WorkflowRun]
    public async Task<OrderResult> RunAsync(CreateOrder command)
    {
        Workflow.Logger.LogInformation("Saga started for OrderId={OrderId}", command.OrderId);

        var compensations = new List<Func<Task>>();
        string? trackingNumber = null;
        var stepDurations = new Dictionary<string, double>();

        try
        {
            // Step 1: Reserve Inventory
            Workflow.Logger.LogInformation("Step 1: ReserveInventory for OrderId={OrderId}", command.OrderId);
            var t0 = Workflow.UtcNow;
            await Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.ReserveInventoryAsync(new ReserveInventory(command.OrderId, command.Items)),
                DefaultActivityOptions);
            stepDurations["reserveInventory"] = (Workflow.UtcNow - t0).TotalMilliseconds;

            compensations.Add(() => Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.ReleaseInventoryAsync(new ReleaseInventory(command.OrderId, command.Items)),
                CompensationActivityOptions));

            // Step 2: Process Payment
            var totalAmount = command.Items.Sum(i => i.Quantity * i.UnitPrice);
            Workflow.Logger.LogInformation("Step 2: ProcessPayment for OrderId={OrderId}, Amount={Amount}", command.OrderId, totalAmount);
            t0 = Workflow.UtcNow;
            await Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.ProcessPaymentAsync(new ProcessPayment(command.OrderId, command.CustomerId, totalAmount)),
                DefaultActivityOptions);
            stepDurations["processPayment"] = (Workflow.UtcNow - t0).TotalMilliseconds;

            compensations.Add(() => Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.RefundPaymentAsync(new RefundPayment(command.OrderId, totalAmount)),
                CompensationActivityOptions));

            // Step 3: Arrange Shipping
            Workflow.Logger.LogInformation("Step 3: ArrangeShipping for OrderId={OrderId}", command.OrderId);
            t0 = Workflow.UtcNow;
            var shippingResult = await Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.ArrangeShippingAsync(new ArrangeShipping(command.OrderId, command.CustomerId, "Default Address")),
                DefaultActivityOptions);
            stepDurations["arrangeShipping"] = (Workflow.UtcNow - t0).TotalMilliseconds;
            trackingNumber = shippingResult.TrackingNumber;

            compensations.Add(() => Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.CancelShippingAsync(new CancelShipping(command.OrderId)),
                CompensationActivityOptions));

            // Step 4: Send Notification (last — non-reversible, no compensation)
            Workflow.Logger.LogInformation("Step 4: SendNotification for OrderId={OrderId}", command.OrderId);
            t0 = Workflow.UtcNow;
            await Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.SendNotificationAsync(
                    new SendNotification(command.OrderId, command.CustomerId, "OrderCompleted",
                        $"Your order {command.OrderId} has been completed. Tracking: {trackingNumber}")),
                DefaultActivityOptions);
            stepDurations["sendNotification"] = (Workflow.UtcNow - t0).TotalMilliseconds;

            // Update order status in DB
            t0 = Workflow.UtcNow;
            await Workflow.ExecuteActivityAsync(
                (OrderActivities act) => act.UpdateOrderStatusAsync(command.OrderId, "Completed", null),
                DefaultActivityOptions);
            stepDurations["updateStatus"] = (Workflow.UtcNow - t0).TotalMilliseconds;

            Workflow.Logger.LogInformation("Saga completed successfully for OrderId={OrderId}", command.OrderId);
            return new OrderResult(command.OrderId, "Completed", null, trackingNumber, stepDurations);
        }
        catch (Exception ex)
        {
            Workflow.Logger.LogWarning("Saga failed for OrderId={OrderId}: {Reason}. Running compensations...", command.OrderId, ex.Message);

            // Mark order as Compensating so the /benchmark poller can measure compensation duration.
            // Uses CompensationActivityOptions (1 attempt, no backoff) so a slow/failing DB doesn't
            // inflate the observed compensation window.
            try
            {
                await Workflow.ExecuteActivityAsync(
                    (OrderActivities act) => act.UpdateOrderStatusAsync(command.OrderId, "Compensating", ex.Message),
                    CompensationActivityOptions);
            }
            catch
            {
                Workflow.Logger.LogWarning("Failed to mark order as Compensating for OrderId={OrderId}", command.OrderId);
            }

            // Run compensations in reverse order
            compensations.Reverse();
            foreach (var compensation in compensations)
            {
                try
                {
                    await compensation();
                }
                catch (Exception compEx)
                {
                    Workflow.Logger.LogError("Compensation failed for OrderId={OrderId}: {Reason}", command.OrderId, compEx.Message);
                }
            }

            // Send failure notification (best-effort) — uses CompensationActivityOptions so a
            // hung NotificationService can't inflate compensationDurationMs.
            try
            {
                await Workflow.ExecuteActivityAsync(
                    (OrderActivities act) => act.SendNotificationAsync(
                        new SendNotification(command.OrderId, command.CustomerId, "OrderFailed",
                            $"Your order {command.OrderId} has failed: {ex.Message}")),
                    CompensationActivityOptions);
            }
            catch
            {
                Workflow.Logger.LogWarning("Failed to send failure notification for OrderId={OrderId}", command.OrderId);
            }

            // Update order status in DB — uses CompensationActivityOptions to match the
            // MassTransit side (which performs a single DB write via the OrderFailed consumer).
            try
            {
                await Workflow.ExecuteActivityAsync(
                    (OrderActivities act) => act.UpdateOrderStatusAsync(command.OrderId, "Failed", ex.Message),
                    CompensationActivityOptions);
            }
            catch
            {
                Workflow.Logger.LogWarning("Failed to update order status for OrderId={OrderId}", command.OrderId);
            }

            Workflow.Logger.LogInformation("Compensations completed for OrderId={OrderId}", command.OrderId);
            return new OrderResult(command.OrderId, "Failed", ex.Message, null, stepDurations);
        }
    }
}
