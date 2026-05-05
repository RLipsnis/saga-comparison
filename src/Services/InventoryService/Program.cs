using MassTransit;
using Microsoft.EntityFrameworkCore;
using InventoryService.Choreography;
using InventoryService.Infrastructure;
using Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

var sagaMode = builder.Configuration.GetValue<string>("SagaMode") ?? "orchestration";

builder.Services.AddControllers();
builder.Services.AddSagaTracing("InventoryService");

builder.Services.AddDbContext<InventoryDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

if (sagaMode == "choreography")
{
    builder.Services.AddMassTransit(x =>
    {
        x.AddConsumer<ReserveInventoryConsumer>();
        x.AddConsumer<ReleaseInventoryConsumer>();

        x.UsingRabbitMq((ctx, cfg) =>
        {
            // Host/credentials come from config so Docker can override
            // (RabbitMQ__Host=rabbitmq) while bare-metal keeps its localhost default.
            var rmqHost = builder.Configuration["RabbitMQ:Host"]     ?? "localhost";
            var rmqUser = builder.Configuration["RabbitMQ:User"]     ?? "saga";
            var rmqPass = builder.Configuration["RabbitMQ:Password"] ?? "saga_dev";
            cfg.Host(rmqHost, "/", h =>
            {
                h.Username(rmqUser);
                h.Password(rmqPass);
            });

            // Retry policy to match Temporal's 3 attempts with exponential backoff
            // (initial 1s, then 2s = 2 retries after first attempt = 3 total attempts)
            cfg.UseMessageRetry(r => r.Intervals(
                TimeSpan.FromSeconds(1),
                TimeSpan.FromSeconds(2)));

            cfg.ConfigureEndpoints(ctx);
        });
    });
}

var app = builder.Build();

using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<InventoryDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

// Runtime-configurable failure rate for the COMPENSATION operation (Release).
// Used by Test M (rollback-failure) to inject failures DURING the saga rollback.
// Reserve is unaffected, so the saga still reaches the compensation step before
// hitting the simulated failure.
app.MapGet("/api/inventory/release-failure-rate", () =>
    Results.Ok(new { releaseFailureRatePercent = InventoryService.Domain.InventoryOperations.ReleaseFailureRatePercent }));

app.MapPost("/api/inventory/release-failure-rate/{rate:int}", (int rate) =>
{
    rate = Math.Clamp(rate, 0, 100);
    InventoryService.Domain.InventoryOperations.ReleaseFailureRatePercent = rate;
    return Results.Ok(new { releaseFailureRatePercent = rate });
});

app.Run();
