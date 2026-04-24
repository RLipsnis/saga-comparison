using Microsoft.AspNetCore.Mvc;
using PaymentService.Domain;
using PaymentService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace PaymentService.Api;

[ApiController]
[Route("api/payments")]
public class PaymentsController : ControllerBase
{
    private readonly PaymentDbContext _db;
    private readonly ILogger<PaymentsController> _logger;

    public PaymentsController(PaymentDbContext db, ILogger<PaymentsController> logger)
    {
        _db = db;
        _logger = logger;
    }

    [HttpPost("process")]
    public async Task<IActionResult> Process([FromBody] ProcessPayment command)
    {
        var result = await PaymentOperations.ProcessAsync(_db, command);

        if (!result.Success)
        {
            _logger.LogWarning("Simulated payment failure for OrderId={OrderId}", command.OrderId);
            return StatusCode(500, new PaymentFailed(command.OrderId, result.Error!));
        }

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "ProcessPayment", result.Event!);

        _logger.LogInformation("Payment processed for OrderId={OrderId}, Amount={Amount}", command.OrderId, command.Amount);
        return Ok(result.Event);
    }

    [HttpPost("refund")]
    public async Task<IActionResult> Refund([FromBody] RefundPayment command)
    {
        var result = await PaymentOperations.RefundAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "RefundPayment", result.Event!);

        _logger.LogInformation("Payment refunded for OrderId={OrderId}, Amount={Amount}", command.OrderId, command.Amount);
        return Ok(result.Event);
    }
}
