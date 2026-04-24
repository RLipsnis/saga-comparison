using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Shared.Infrastructure;

public static class IdempotencyHelper
{
    public static async Task<TResult?> CheckAsync<TResult>(DbContext context, Guid key, string operation)
        where TResult : class
    {
        var record = await context.Set<IdempotencyRecord>()
            .FirstOrDefaultAsync(r => r.Key == key && r.OperationType == operation);

        if (record?.ResultJson is null)
            return null;

        return JsonSerializer.Deserialize<TResult>(record.ResultJson);
    }

    public static async Task SaveAsync(DbContext context, Guid key, string operation, object result)
    {
        context.Set<IdempotencyRecord>().Add(new IdempotencyRecord
        {
            Id = Guid.NewGuid(),
            Key = key,
            OperationType = operation,
            ResultJson = JsonSerializer.Serialize(result),
            CreatedAt = DateTime.UtcNow
        });

        await context.SaveChangesAsync();
    }
}
