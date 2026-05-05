using MassTransit;
using Microsoft.EntityFrameworkCore;
using ShippingService.Choreography;
using ShippingService.Infrastructure;
using Shared.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

var sagaMode = builder.Configuration.GetValue<string>("SagaMode") ?? "orchestration";

builder.Services.AddControllers();
builder.Services.AddSagaTracing("ShippingService");

builder.Services.AddDbContext<ShippingDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

if (sagaMode == "choreography")
{
    builder.Services.AddMassTransit(x =>
    {
        x.AddConsumer<ArrangeShippingConsumer>();
        x.AddConsumer<CancelShippingConsumer>();

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
    scope.ServiceProvider.GetRequiredService<ShippingDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

app.Run();
