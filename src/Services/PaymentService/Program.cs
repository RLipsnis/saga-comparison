using MassTransit;
using Microsoft.EntityFrameworkCore;
using PaymentService.Choreography;
using PaymentService.Infrastructure;
using Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

var sagaMode = builder.Configuration.GetValue<string>("SagaMode") ?? "orchestration";

builder.Services.AddControllers();
builder.Services.AddSagaTracing("PaymentService");

builder.Services.AddDbContext<PaymentDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

if (sagaMode == "choreography")
{
    builder.Services.AddMassTransit(x =>
    {
        x.AddConsumer<ProcessPaymentConsumer>();
        x.AddConsumer<RefundPaymentConsumer>();

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

// Initialize configurable failure rate from appsettings.
// Default is 0% so happy-path benchmarks run cleanly; Test I (compensation) sets
// it to 100 at runtime via POST /api/payments/failure-rate/100.
PaymentService.Domain.PaymentOperations.FailureRatePercent =
    builder.Configuration.GetValue<int>("PaymentFailureRatePercent", 0);

var app = builder.Build();

using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<PaymentDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

// Runtime-configurable failure rate: GET to read, POST to change
app.MapGet("/api/payments/failure-rate", () =>
    Results.Ok(new { failureRatePercent = PaymentService.Domain.PaymentOperations.FailureRatePercent }));

app.MapPost("/api/payments/failure-rate/{rate:int}", (int rate) =>
{
    rate = Math.Clamp(rate, 0, 100);
    PaymentService.Domain.PaymentOperations.FailureRatePercent = rate;
    return Results.Ok(new { failureRatePercent = rate });
});

app.Run();
