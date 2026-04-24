using MassTransit;
using PaymentService.Domain;
using PaymentService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace PaymentService.Choreography;

public class RefundPaymentConsumer : IConsumer<RefundPayment>
{
    private readonly PaymentDbContext _db;
    private readonly ILogger<RefundPaymentConsumer> _logger;

    public RefundPaymentConsumer(PaymentDbContext db, ILogger<RefundPaymentConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<RefundPayment> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] RefundPayment (compensation) for OrderId={OrderId}", command.OrderId);

        var result = await PaymentOperations.RefundAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "RefundPayment", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] PaymentRefunded published for OrderId={OrderId}", command.OrderId);
    }
}
