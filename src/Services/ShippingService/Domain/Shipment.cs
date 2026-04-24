namespace ShippingService.Domain;

public class Shipment
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public Guid CustomerId { get; set; }
    public string Address { get; set; } = string.Empty;
    public string? TrackingNumber { get; set; }
    public ShipmentStatus Status { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? ArrangedAt { get; set; }
}
