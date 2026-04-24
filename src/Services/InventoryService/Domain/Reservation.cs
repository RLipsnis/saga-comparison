namespace InventoryService.Domain;

public class Reservation
{
    public Guid Id { get; set; }
    public Guid OrderId { get; set; }
    public Guid ProductId { get; set; }
    public int Quantity { get; set; }
    public ReservationStatus Status { get; set; }
    public DateTime CreatedAt { get; set; }
}
