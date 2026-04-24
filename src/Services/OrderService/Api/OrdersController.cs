using System.Text.Json;
using MassTransit;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using OrderService.Domain;
using OrderService.Infrastructure;
using OrderService.Orchestration;
using Shared.Contracts;
using Temporalio.Client;

namespace OrderService.Api;

public record CreateOrderRequest(Guid CustomerId, List<OrderItemDto> Items, Guid? IdempotencyKey);

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly ITemporalClient? _temporalClient;
    private readonly IPublishEndpoint? _publishEndpoint;
    private readonly OrderDbContext _db;
    private readonly IConfiguration _configuration;
    private readonly ILogger<OrdersController> _logger;

    public OrdersController(
        OrderDbContext db,
        IConfiguration configuration,
        ILogger<OrdersController> logger,
        ITemporalClient? temporalClient = null,
        IPublishEndpoint? publishEndpoint = null)
    {
        _db = db;
        _configuration = configuration;
        _logger = logger;
        _temporalClient = temporalClient;
        _publishEndpoint = publishEndpoint;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateOrderRequest request)
    {
        var sagaMode = _configuration.GetValue<string>("SagaMode") ?? "orchestration";
        var orderId = Guid.NewGuid();
        var idempotencyKey = request.IdempotencyKey ?? Guid.NewGuid();

        var order = new Order
        {
            Id = orderId,
            CustomerId = request.CustomerId,
            TotalAmount = request.Items.Sum(i => i.Quantity * i.UnitPrice),
            Status = OrderStatus.Pending,
            ItemsJson = JsonSerializer.Serialize(request.Items),
            CreatedAt = DateTime.UtcNow
        };

        _db.Orders.Add(order);
        await _db.SaveChangesAsync();

        if (sagaMode == "orchestration")
        {
            var taskQueue = _configuration["Temporal:TaskQueue"] ?? "order-saga-queue";
            var command = new CreateOrder(orderId, request.CustomerId, request.Items, idempotencyKey);
            var workflowId = $"order-{orderId}";

            var handle = await _temporalClient!.StartWorkflowAsync(
                (OrderSagaWorkflow wf) => wf.RunAsync(command),
                new WorkflowOptions(workflowId, taskQueue));

            _logger.LogInformation("[Orchestration] Order created, workflow started. OrderId={OrderId}, WorkflowId={WorkflowId}",
                orderId, workflowId);

            return Accepted(new { OrderId = orderId, WorkflowId = workflowId, Mode = "orchestration" });
        }
        else
        {
            var orderCreated = new OrderCreated(orderId, request.CustomerId, request.Items, DateTime.UtcNow);
            await _publishEndpoint!.Publish(orderCreated);

            _logger.LogInformation("[Choreography] Order created, OrderCreated event published. OrderId={OrderId}", orderId);

            return Accepted(new { OrderId = orderId, Mode = "choreography" });
        }
    }

    [HttpGet("{orderId:guid}/status")]
    public async Task<IActionResult> GetStatus(Guid orderId)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == orderId);
        if (order is null)
            return NotFound();

        return Ok(new
        {
            order.Id,
            Status = order.Status.ToString(),
            order.FailureReason,
            order.CreatedAt,
            order.CompletedAt
        });
    }

    [HttpGet]
    public async Task<IActionResult> GetAll()
    {
        var orders = await _db.Orders
            .OrderByDescending(o => o.CreatedAt)
            .Take(20)
            .Select(o => new
            {
                o.Id,
                o.CustomerId,
                Status = o.Status.ToString(),
                o.TotalAmount,
                o.FailureReason,
                o.CreatedAt,
                o.CompletedAt
            })
            .ToListAsync();

        return Ok(orders);
    }

    [HttpGet("recent")]
    public async Task<IActionResult> GetRecent([FromQuery] int limit = 20)
    {
        var orders = await _db.Orders
            .OrderByDescending(o => o.CreatedAt)
            .Take(limit)
            .Select(o => new
            {
                o.Id,
                o.CustomerId,
                Status = o.Status.ToString(),
                o.TotalAmount,
                o.FailureReason,
                o.CreatedAt,
                o.CompletedAt
            })
            .ToListAsync();

        return Ok(orders);
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        var sagaMode = _configuration.GetValue<string>("SagaMode") ?? "orchestration";
        return Ok(new { sagaMode });
    }

    [HttpGet("{orderId:guid}/stream")]
    public async Task Stream(Guid orderId)
    {
        Response.Headers["Content-Type"] = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["Connection"] = "keep-alive";

        var stepNames = new[] { "Inventory", "Payment", "Shipping", "Notification" };

        for (var i = 0; i < 120; i++) // max 60 seconds
        {
            if (HttpContext.RequestAborted.IsCancellationRequested) break;

            var order = await _db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == orderId);
            if (order is null) break;

            var steps = BuildSteps(order, stepNames);

            var data = JsonSerializer.Serialize(new
            {
                orderId = order.Id,
                status = order.Status.ToString(),
                failureReason = order.FailureReason,
                createdAt = order.CreatedAt,
                completedAt = order.CompletedAt,
                steps
            });

            await Response.WriteAsync($"data: {data}\n\n");
            await Response.Body.FlushAsync();

            if (order.Status is OrderStatus.Completed or OrderStatus.Failed)
                break;

            await Task.Delay(500);
        }
    }

    [HttpPost("benchmark")]
    public async Task<IActionResult> Benchmark([FromBody] CreateOrderRequest request)
    {
        var sagaMode = _configuration.GetValue<string>("SagaMode") ?? "orchestration";
        var orderId = Guid.NewGuid();
        var idempotencyKey = request.IdempotencyKey ?? Guid.NewGuid();
        var timestamps = new Dictionary<string, DateTime> { ["requestReceived"] = DateTime.UtcNow };

        var order = new Order
        {
            Id = orderId,
            CustomerId = request.CustomerId,
            TotalAmount = request.Items.Sum(i => i.Quantity * i.UnitPrice),
            Status = OrderStatus.Pending,
            ItemsJson = JsonSerializer.Serialize(request.Items),
            CreatedAt = DateTime.UtcNow
        };

        _db.Orders.Add(order);
        await _db.SaveChangesAsync();
        timestamps["orderPersisted"] = DateTime.UtcNow;

        if (sagaMode == "orchestration")
        {
            var taskQueue = _configuration["Temporal:TaskQueue"] ?? "order-saga-queue";
            var command = new CreateOrder(orderId, request.CustomerId, request.Items, idempotencyKey);
            var workflowId = $"order-{orderId}";
            await _temporalClient!.StartWorkflowAsync(
                (OrderSagaWorkflow wf) => wf.RunAsync(command),
                new WorkflowOptions(workflowId, taskQueue));
        }
        else
        {
            await _publishEndpoint!.Publish(new OrderCreated(orderId, request.CustomerId, request.Items, DateTime.UtcNow));
        }
        timestamps["sagaInitiated"] = DateTime.UtcNow;

        // Poll until terminal state (max 30s)
        var prevStatus = "Pending";
        var stepTimestamps = new Dictionary<string, DateTime>();
        var compensationStarted = false;
        DateTime? compensationStartTime = null;
        for (var i = 0; i < 300; i++)
        {
            await Task.Delay(100);
            var current = await _db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == orderId);
            if (current is null) break;

            var statusStr = current.Status.ToString();
            if (statusStr != prevStatus)
            {
                stepTimestamps[statusStr] = DateTime.UtcNow;

                if (statusStr == "Compensating" && !compensationStarted)
                {
                    compensationStarted = true;
                    compensationStartTime = DateTime.UtcNow;
                    timestamps["compensationStarted"] = DateTime.UtcNow;
                }

                prevStatus = statusStr;
            }

            if (current.Status is OrderStatus.Completed or OrderStatus.Failed)
            {
                timestamps["sagaCompleted"] = DateTime.UtcNow;
                if (compensationStarted)
                    timestamps["compensationCompleted"] = DateTime.UtcNow;
                break;
            }
        }

        var finalOrder = await _db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == orderId);
        var apiResponseMs = (timestamps["sagaInitiated"] - timestamps["requestReceived"]).TotalMilliseconds;
        var totalSagaMs = timestamps.ContainsKey("sagaCompleted")
            ? (timestamps["sagaCompleted"] - timestamps["sagaInitiated"]).TotalMilliseconds
            : -1;
        var compensationMs = (compensationStartTime.HasValue && timestamps.ContainsKey("compensationCompleted"))
            ? (timestamps["compensationCompleted"] - compensationStartTime.Value).TotalMilliseconds
            : (double?)null;

        // Collect per-step durations
        Dictionary<string, double>? stepDurationsMs = null;

        if (sagaMode == "orchestration")
        {
            // Fetch the workflow result which contains per-step timings from Workflow.UtcNow
            try
            {
                var workflowId = $"order-{orderId}";
                var handle = _temporalClient!.GetWorkflowHandle<OrderSagaWorkflow>(workflowId);
                var result = await handle.GetResultAsync<OrderResult>();
                stepDurationsMs = result.StepDurationsMs?
                    .ToDictionary(kv => kv.Key, kv => Math.Round(kv.Value, 1));
            }
            catch { /* workflow may not be reachable */ }
        }
        else
        {
            // Query saga state timestamps from the choreography state table
            try
            {
                var sagaState = await _db.Set<OrderService.Choreography.OrderSagaState>()
                    .AsNoTracking()
                    .FirstOrDefaultAsync(s => s.CorrelationId == orderId);

                if (sagaState is not null)
                {
                    stepDurationsMs = new Dictionary<string, double>();
                    var baseTime = sagaState.CreatedAt;

                    if (sagaState.InventoryReservedAt.HasValue)
                    {
                        stepDurationsMs["reserveInventory"] = Math.Round(
                            (sagaState.InventoryReservedAt.Value - baseTime).TotalMilliseconds, 1);
                        baseTime = sagaState.InventoryReservedAt.Value;
                    }
                    if (sagaState.PaymentProcessedAt.HasValue)
                    {
                        stepDurationsMs["processPayment"] = Math.Round(
                            (sagaState.PaymentProcessedAt.Value - baseTime).TotalMilliseconds, 1);
                        baseTime = sagaState.PaymentProcessedAt.Value;
                    }
                    if (sagaState.ShippingArrangedAt.HasValue)
                    {
                        stepDurationsMs["arrangeShipping"] = Math.Round(
                            (sagaState.ShippingArrangedAt.Value - baseTime).TotalMilliseconds, 1);
                        baseTime = sagaState.ShippingArrangedAt.Value;
                    }
                    if (sagaState.NotificationSentAt.HasValue)
                    {
                        stepDurationsMs["sendNotification"] = Math.Round(
                            (sagaState.NotificationSentAt.Value - baseTime).TotalMilliseconds, 1);
                        baseTime = sagaState.NotificationSentAt.Value;
                    }
                    if (finalOrder?.CompletedAt.HasValue == true && sagaState.NotificationSentAt.HasValue)
                    {
                        stepDurationsMs["updateStatus"] = Math.Round(
                            (finalOrder.CompletedAt.Value - sagaState.NotificationSentAt.Value).TotalMilliseconds, 1);
                    }
                }
            }
            catch { /* saga state may have been finalized/removed */ }
        }

        return Ok(new
        {
            orderId,
            sagaMode,
            finalStatus = finalOrder?.Status.ToString(),
            failureReason = finalOrder?.FailureReason,
            apiResponseMs = Math.Round(apiResponseMs, 1),
            totalSagaDurationMs = Math.Round(totalSagaMs, 1),
            compensated = compensationStarted,
            compensationDurationMs = compensationMs.HasValue ? Math.Round(compensationMs.Value, 1) : (double?)null,
            stepDurationsMs,
            stepTransitions = stepTimestamps.ToDictionary(
                kv => kv.Key,
                kv => Math.Round((kv.Value - timestamps["sagaInitiated"]).TotalMilliseconds, 1)),
            timestamps = timestamps.ToDictionary(kv => kv.Key, kv => kv.Value.ToString("O"))
        });
    }

    [HttpDelete("reset")]
    public async Task<IActionResult> Reset()
    {
        await _db.Orders.ExecuteDeleteAsync();
        _logger.LogInformation("All orders deleted");
        return Ok(new { message = "All orders deleted" });
    }

    private static List<object> BuildSteps(Order order, string[] stepNames)
    {
        var statusMap = new Dictionary<OrderStatus, int>
        {
            [OrderStatus.Pending] = 0,
            [OrderStatus.InventoryReserved] = 1,
            [OrderStatus.PaymentProcessed] = 2,
            [OrderStatus.ShippingArranged] = 3,
            [OrderStatus.Completed] = 4,
            [OrderStatus.Failed] = -1,
            [OrderStatus.Compensating] = -1
        };

        var completedSteps = statusMap.GetValueOrDefault(order.Status, 0);
        var steps = new List<object>();

        for (var i = 0; i < stepNames.Length; i++)
        {
            string stepStatus;
            if (order.Status == OrderStatus.Failed || order.Status == OrderStatus.Compensating)
                stepStatus = i < completedSteps ? "completed" : (i == completedSteps ? "failed" : "pending");
            else if (order.Status == OrderStatus.Completed)
                stepStatus = "completed";
            else
                stepStatus = i < completedSteps ? "completed" : (i == completedSteps ? "in_progress" : "pending");

            steps.Add(new { name = stepNames[i], status = stepStatus });
        }

        return steps;
    }
}
