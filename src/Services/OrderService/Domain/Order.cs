namespace OrderService.Domain;

public class Order
{
    public Guid Id { get; set; }
    public Guid CustomerId { get; set; }
    public decimal TotalAmount { get; set; }
    public OrderStatus Status { get; set; }
    public string? FailureReason { get; set; }
    public string ItemsJson { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}
