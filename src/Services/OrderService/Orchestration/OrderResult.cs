namespace OrderService.Orchestration;

public record OrderResult(
    Guid OrderId,
    string Status,
    string? FailureReason,
    string? TrackingNumber,
    Dictionary<string, double>? StepDurationsMs = null);
