namespace OrderService.Domain;

public enum OrderStatus
{
    Pending,
    InventoryReserved,
    PaymentProcessed,
    ShippingArranged,
    Completed,
    Failed,
    Compensating
}
