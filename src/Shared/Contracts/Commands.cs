namespace Shared.Contracts;

public record OrderItemDto(Guid ProductId, int Quantity, decimal UnitPrice);

public record CreateOrder(Guid OrderId, Guid CustomerId, List<OrderItemDto> Items, Guid IdempotencyKey);
public record ReserveInventory(Guid OrderId, List<OrderItemDto> Items);
public record ReleaseInventory(Guid OrderId, List<OrderItemDto> Items);
public record ProcessPayment(Guid OrderId, Guid CustomerId, decimal Amount);
public record RefundPayment(Guid OrderId, decimal Amount);
public record ArrangeShipping(Guid OrderId, Guid CustomerId, string Address);
public record CancelShipping(Guid OrderId);
public record SendNotification(Guid OrderId, Guid CustomerId, string Type, string Message);
