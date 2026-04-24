using MassTransit;

namespace OrderService.Choreography;

public class OrderSagaState : SagaStateMachineInstance
{
    public Guid CorrelationId { get; set; }
    public string CurrentState { get; set; } = string.Empty;
    public Guid CustomerId { get; set; }
    public string ItemsJson { get; set; } = string.Empty;
    public decimal TotalAmount { get; set; }
    public string? Address { get; set; }
    public string? TrackingNumber { get; set; }
    public string? FailureReason { get; set; }
    public DateTime CreatedAt { get; set; }
    public int Version { get; set; }

    // Per-step timestamps for benchmarking
    public DateTime? InventoryReservedAt { get; set; }
    public DateTime? PaymentProcessedAt { get; set; }
    public DateTime? ShippingArrangedAt { get; set; }
    public DateTime? NotificationSentAt { get; set; }
    public DateTime? CompletedAt { get; set; }

    // Compensation tracking flags
    public bool CompensatingInventory { get; set; }
    public bool CompensatingPayment { get; set; }
    public bool InventoryCompensated { get; set; }
    public bool PaymentCompensated { get; set; }
}
