using Microsoft.EntityFrameworkCore;
using PaymentService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace PaymentService.Domain;

public record ProcessResult(bool Success, string? Error, PaymentProcessed? Event);
public record RefundResult(bool Success, PaymentRefunded? Event);

public static class PaymentOperations
{
    private static readonly Random Rng = new();

    // Default is 0% so happy-path benchmarks (saga-step, step-duration, consistency-lag, etc.)
    // are not contaminated by random failures. Test I sets this to 100 via POST
    // /api/payments/failure-rate/100 to exercise the compensation path.
    public static int FailureRatePercent { get; set; } = 0;

    public static async Task<ProcessResult> ProcessAsync(PaymentDbContext db, ProcessPayment command)
    {
        var cached = await IdempotencyHelper.CheckAsync<PaymentProcessed>(db, command.OrderId, "ProcessPayment");
        if (cached is not null)
            return new ProcessResult(true, null, cached);

        // Simulate external payment gateway delay
        await Task.Delay(Rng.Next(50, 201));

        // Configurable failure rate (default 5%, set to 100 for forced-failure testing)
        if (Rng.Next(100) < FailureRatePercent)
            return new ProcessResult(false, "Payment gateway declined the transaction", null);

        var payment = new Payment
        {
            Id = Guid.NewGuid(),
            OrderId = command.OrderId,
            CustomerId = command.CustomerId,
            Amount = command.Amount,
            Status = PaymentStatus.Processed,
            CreatedAt = DateTime.UtcNow,
            ProcessedAt = DateTime.UtcNow
        };

        db.Payments.Add(payment);

        var result = new PaymentProcessed(command.OrderId, command.Amount, DateTime.UtcNow);
        return new ProcessResult(true, null, result);
    }

    public static async Task<RefundResult> RefundAsync(PaymentDbContext db, RefundPayment command)
    {
        var cached = await IdempotencyHelper.CheckAsync<PaymentRefunded>(db, command.OrderId, "RefundPayment");
        if (cached is not null)
            return new RefundResult(true, cached);

        var payment = await db.Payments.FirstOrDefaultAsync(p => p.OrderId == command.OrderId);
        if (payment is not null)
            payment.Status = PaymentStatus.Refunded;

        var result = new PaymentRefunded(command.OrderId, command.Amount);
        return new RefundResult(true, result);
    }
}
