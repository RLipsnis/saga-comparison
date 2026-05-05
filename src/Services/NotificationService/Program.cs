using MassTransit;
using Microsoft.EntityFrameworkCore;
using NotificationService.Choreography;
using NotificationService.Infrastructure;
using Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

var sagaMode = builder.Configuration.GetValue<string>("SagaMode") ?? "orchestration";

builder.Services.AddControllers();
builder.Services.AddSagaTracing("NotificationService");

builder.Services.AddDbContext<NotificationDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

if (sagaMode == "choreography")
{
    builder.Services.AddMassTransit(x =>
    {
        x.AddConsumer<SendNotificationConsumer>();

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
            cfg.UseMessageRetry(r => r.Intervals(
                TimeSpan.FromSeconds(1),
                TimeSpan.FromSeconds(2)));

            cfg.ConfigureEndpoints(ctx);
        });
    });
}

var app = builder.Build();

using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<NotificationDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

// Runtime-configurable failure rate. Used by Test M (rollback-failure) to inject
// failures during the saga's failure-notification step.
app.MapGet("/api/notifications/failure-rate", () =>
    Results.Ok(new { failureRatePercent = NotificationService.Domain.NotificationOperations.FailureRatePercent }));

app.MapPost("/api/notifications/failure-rate/{rate:int}", (int rate) =>
{
    rate = Math.Clamp(rate, 0, 100);
    NotificationService.Domain.NotificationOperations.FailureRatePercent = rate;
    return Results.Ok(new { failureRatePercent = rate });
});

app.Run();
