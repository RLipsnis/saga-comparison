namespace Shared.Contracts;

public record OrderCreated(Guid OrderId, Guid CustomerId, List<OrderItemDto> Items, DateTime CreatedAt);
public record OrderCompleted(Guid OrderId, DateTime CompletedAt);
public record OrderCompensating(Guid OrderId, string Reason, DateTime StartedAt);
public record OrderFailed(Guid OrderId, string Reason, DateTime FailedAt);

public record InventoryReserved(Guid OrderId, DateTime ReservedAt);
public record InventoryReservationFailed(Guid OrderId, string Reason);
public record InventoryReleased(Guid OrderId);

public record PaymentProcessed(Guid OrderId, decimal Amount, DateTime ProcessedAt);
public record PaymentFailed(Guid OrderId, string Reason);
public record PaymentRefunded(Guid OrderId, decimal Amount);

public record ShippingArranged(Guid OrderId, string TrackingNumber, DateTime ArrangedAt);
public record ShippingFailed(Guid OrderId, string Reason);
public record ShippingCancelled(Guid OrderId);

public record NotificationSent(Guid OrderId, string Type, DateTime SentAt);
