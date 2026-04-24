using Microsoft.AspNetCore.Mvc;
using NotificationService.Domain;
using NotificationService.Infrastructure;
using Shared.Contracts;
using Shared.Infrastructure;

namespace NotificationService.Api;

[ApiController]
[Route("api/notifications")]
public class NotificationsController : ControllerBase
{
    private readonly NotificationDbContext _db;
    private readonly ILogger<NotificationsController> _logger;

    public NotificationsController(NotificationDbContext db, ILogger<NotificationsController> logger)
    {
        _db = db;
        _logger = logger;
    }

    [HttpPost("send")]
    public async Task<IActionResult> Send([FromBody] SendNotification command)
    {
        var result = await NotificationOperations.SendAsync(_db, command);

        await _db.SaveChangesAsync();
        await IdempotencyHelper.SaveAsync(_db, command.OrderId, "SendNotification", result.Event!);

        _logger.LogInformation("[NOTIFICATION] OrderId={OrderId}, Type={Type}, Message={Message}",
            command.OrderId, command.Type, command.Message);
        return Ok(result.Event);
    }
}
