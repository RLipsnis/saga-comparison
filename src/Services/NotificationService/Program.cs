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
            cfg.Host("localhost", "/", h =>
            {
                h.Username("saga");
                h.Password("saga_dev");
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

app.Run();
