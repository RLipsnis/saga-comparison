namespace Shared.Infrastructure;

public class IdempotencyRecord
{
    public Guid Id { get; set; }
    public Guid Key { get; set; }
    public string OperationType { get; set; } = string.Empty;
    public string? ResultJson { get; set; }
    public DateTime CreatedAt { get; set; }
}
