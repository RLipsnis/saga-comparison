using NotificationService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace NotificationService.Domain;

public record SendResult(bool Success, NotificationSent? Event);

public static class NotificationOperations
{
    private static readonly Random Rng = new();

    // Failure-injection toggle. Used by Test M (rollback-failure) to reproduce
    // the lecturer's "Notification service down during rollback" scenario.
    // Default 0 keeps every other benchmark unaffected.
    public static int FailureRatePercent { get; set; } = 0;

    public static async Task<SendResult> SendAsync(NotificationDbContext db, SendNotification command)
    {
        // Throw BEFORE the idempotency check so a permanently-failing Send does
        // not poison the cache. On retry (after rate is set back to 0) the
        // operation runs fresh and can succeed.
        if (FailureRatePercent > 0 && Rng.Next(100) < FailureRatePercent)
            throw new InvalidOperationException("Simulated NotificationService.Send failure (rollback-failure test)");

        var cached = await IdempotencyHelper.CheckAsync<NotificationSent>(db, command.OrderId, "SendNotification");
        if (cached is not null)
            return new SendResult(true, cached);

        // Simulate sending notification
        await Task.Delay(Rng.Next(10, 51));

        var notification = new Notification
        {
            Id = Guid.NewGuid(),
            OrderId = command.OrderId,
            CustomerId = command.CustomerId,
            Type = command.Type,
            Message = command.Message,
            Status = NotificationStatus.Sent,
            CreatedAt = DateTime.UtcNow,
            SentAt = DateTime.UtcNow
        };

        db.Notifications.Add(notification);

        var result = new NotificationSent(command.OrderId, command.Type, DateTime.UtcNow);
        return new SendResult(true, result);
    }
}
