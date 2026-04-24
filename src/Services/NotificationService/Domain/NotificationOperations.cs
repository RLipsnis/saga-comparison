using NotificationService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace NotificationService.Domain;

public record SendResult(bool Success, NotificationSent? Event);

public static class NotificationOperations
{
    private static readonly Random Rng = new();

    public static async Task<SendResult> SendAsync(NotificationDbContext db, SendNotification command)
    {
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
