using MassTransit;
using PaymentService.Domain;
using PaymentService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace PaymentService.Choreography;

public class ProcessPaymentConsumer : IConsumer<ProcessPayment>
{
    private readonly PaymentDbContext _db;
    private readonly ILogger<ProcessPaymentConsumer> _logger;

    public ProcessPaymentConsumer(PaymentDbContext db, ILogger<ProcessPaymentConsumer> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task Consume(ConsumeContext<ProcessPayment> context)
    {
        var command = context.Message;
        _logger.LogInformation("[Choreography] ProcessPayment for OrderId={OrderId}, Amount={Amount}", command.OrderId, command.Amount);

        var result = await PaymentOperations.ProcessAsync(_db, command);

        if (!result.Success)
        {
            _logger.LogWarning("[Choreography] ProcessPayment failed for OrderId={OrderId}: {Error}", command.OrderId, result.Error);
            await context.Publish(new PaymentFailed(command.OrderId, result.Error!));
            return;
        }

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ProcessPayment", result.Event!);
        await context.Publish(result.Event!);

        _logger.LogInformation("[Choreography] PaymentProcessed published for OrderId={OrderId}", command.OrderId);
    }
}
