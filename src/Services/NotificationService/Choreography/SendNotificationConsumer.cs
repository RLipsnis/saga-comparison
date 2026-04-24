using MassTransit;
using NotificationService.Domain;
using NotificationService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace NotificationService.Choreography;

public class SendNotificationConsumer : IConsumer<SendNotification>
{
    private readonly NotificationDbContext _db;
    private readonly ILogger<SendNotificationConsumer> _logger;

    public SendNotificationConsumer(NotificationDbContext db, ILogger<SendNotificationConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<SendNotification> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] SendNotification for OrderId={OrderId}, Type={Type}", command.OrderId, command.Type);

        var result = await NotificationOperations.SendAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "SendNotification", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] NotificationSent published for OrderId={OrderId}, Type={Type}", command.OrderId, command.Type);
    }
}
