using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using OrderService.Domain;
using OrderService.Infrastructure;
using Shared.Contracts;
using Temporalio.Activities;

namespace OrderService.Orchestration;

public class OrderActivities
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly OrderDbContext _db;
    private readonly ILogger<OrderActivities> _logger;

    public OrderActivities(IHttpClientFactory httpClientFactory, OrderDbContext db, ILogger<OrderActivities> logger)
    {
        _httpClientFactory = httpClientFactory;
        _db = db;
        _logger = logger;
    }

    [Activity]
    public async Task UpdateOrderStatusAsync(Guid orderId, string status, string? failureReason)
    {
        var order = await _db.Orders.FirstOrDefaultAsync(o => o.Id == orderId);
        if (order is null) return;

        order.Status = Enum.Parse<OrderStatus>(status);
        order.FailureReason = failureReason;
        if (status is "Completed" or "Failed")
            order.CompletedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();
        _logger.LogInformation("Order {OrderId} status updated to {Status}", orderId, status);
    }

    [Activity]
    public async Task<InventoryReserved> ReserveInventoryAsync(ReserveInventory command)
    {
        _logger.LogInformation("Activity: ReserveInventory for OrderId={OrderId}", command.OrderId);
        var client = _httpClientFactory.CreateClient("InventoryService");
        var response = await client.PostAsJsonAsync("/api/inventory/reserve", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("ReserveInventory failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"ReserveInventory failed: {body}");
        }

        var result = await response.Content.ReadFromJsonAsync<InventoryReserved>();
        _logger.LogInformation("Activity: InventoryReserved for OrderId={OrderId}", command.OrderId);
        return result!;
    }

    [Activity]
    public async Task ReleaseInventoryAsync(ReleaseInventory command)
    {
        _logger.LogInformation("Activity: ReleaseInventory (compensation) for OrderId={OrderId}", command.OrderId);
        var client = _httpClientFactory.CreateClient("InventoryService");
        var response = await client.PostAsJsonAsync("/api/inventory/release", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("ReleaseInventory failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"ReleaseInventory failed: {body}");
        }

        _logger.LogInformation("Activity: InventoryReleased for OrderId={OrderId}", command.OrderId);
    }

    [Activity]
    public async Task<PaymentProcessed> ProcessPaymentAsync(ProcessPayment command)
    {
        _logger.LogInformation("Activity: ProcessPayment for OrderId={OrderId}, Amount={Amount}", command.OrderId, command.Amount);
        var client = _httpClientFactory.CreateClient("PaymentService");
        var response = await client.PostAsJsonAsync("/api/payments/process", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("ProcessPayment failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"ProcessPayment failed: {body}");
        }

        var result = await response.Content.ReadFromJsonAsync<PaymentProcessed>();
        _logger.LogInformation("Activity: PaymentProcessed for OrderId={OrderId}", command.OrderId);
        return result!;
    }

    [Activity]
    public async Task RefundPaymentAsync(RefundPayment command)
    {
        _logger.LogInformation("Activity: RefundPayment (compensation) for OrderId={OrderId}", command.OrderId);
        var client = _httpClientFactory.CreateClient("PaymentService");
        var response = await client.PostAsJsonAsync("/api/payments/refund", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("RefundPayment failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"RefundPayment failed: {body}");
        }

        _logger.LogInformation("Activity: PaymentRefunded for OrderId={OrderId}", command.OrderId);
    }

    [Activity]
    public async Task<ShippingArranged> ArrangeShippingAsync(ArrangeShipping command)
    {
        _logger.LogInformation("Activity: ArrangeShipping for OrderId={OrderId}", command.OrderId);
        var client = _httpClientFactory.CreateClient("ShippingService");
        var response = await client.PostAsJsonAsync("/api/shipping/arrange", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("ArrangeShipping failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"ArrangeShipping failed: {body}");
        }

        var result = await response.Content.ReadFromJsonAsync<ShippingArranged>();
        _logger.LogInformation("Activity: ShippingArranged for OrderId={OrderId}, Tracking={Tracking}", command.OrderId, result!.TrackingNumber);
        return result;
    }

    [Activity]
    public async Task CancelShippingAsync(CancelShipping command)
    {
        _logger.LogInformation("Activity: CancelShipping (compensation) for OrderId={OrderId}", command.OrderId);
        var client = _httpClientFactory.CreateClient("ShippingService");
        var response = await client.PostAsJsonAsync("/api/shipping/cancel", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("CancelShipping failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"CancelShipping failed: {body}");
        }

        _logger.LogInformation("Activity: ShippingCancelled for OrderId={OrderId}", command.OrderId);
    }

    [Activity]
    public async Task SendNotificationAsync(SendNotification command)
    {
        _logger.LogInformation("Activity: SendNotification for OrderId={OrderId}, Type={Type}", command.OrderId, command.Type);
        var client = _httpClientFactory.CreateClient("NotificationService");
        var response = await client.PostAsJsonAsync("/api/notifications/send", command);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            _logger.LogWarning("SendNotification failed for OrderId={OrderId}: {Body}", command.OrderId, body);
            throw new ApplicationException($"SendNotification failed: {body}");
        }

        _logger.LogInformation("Activity: NotificationSent for OrderId={OrderId}", command.OrderId);
    }
}
