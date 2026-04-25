using MassTransit;
using Microsoft.EntityFrameworkCore;
using OrderService.Choreography;
using OrderService.Infrastructure;
using OrderService.Orchestration;
using Shared.Infrastructure;
using Temporalio.Extensions.Hosting;

var builder = WebApplication.CreateBuilder(args);

var sagaMode = builder.Configuration.GetValue<string>("SagaMode") ?? "orchestration";

builder.Services.AddControllers();
builder.Services.AddSagaTracing("OrderService");

builder.Services.AddDbContext<OrderDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

if (sagaMode == "orchestration")
{
    // Named HttpClients for downstream services (orchestration uses REST)
    builder.Services.AddHttpClient("InventoryService", c => c.BaseAddress = new Uri("http://localhost:5011"));
    builder.Services.AddHttpClient("PaymentService", c => c.BaseAddress = new Uri("http://localhost:5012"));
    builder.Services.AddHttpClient("ShippingService", c => c.BaseAddress = new Uri("http://localhost:5013"));
    builder.Services.AddHttpClient("NotificationService", c => c.BaseAddress = new Uri("http://localhost:5014"));

    // Temporal client + worker
    var temporalHost = builder.Configuration["Temporal:Host"] ?? "localhost:7233";
    var temporalNamespace = builder.Configuration["Temporal:Namespace"] ?? "default";
    var taskQueue = builder.Configuration["Temporal:TaskQueue"] ?? "order-saga-queue";

    builder.Services.AddTemporalClient(opts =>
    {
        opts.TargetHost = temporalHost;
        opts.Namespace = temporalNamespace;
    });

    builder.Services.AddHostedTemporalWorker(taskQueue)
        .AddScopedActivities<OrderActivities>()
        .AddWorkflow<OrderSagaWorkflow>();
}
else if (sagaMode == "choreography")
{
    builder.Services.AddMassTransit(x =>
    {
        x.AddSagaStateMachine<OrderSagaStateMachine, OrderSagaState>()
            .EntityFrameworkRepository(r =>
            {
                r.ConcurrencyMode = ConcurrencyMode.Optimistic;
                r.AddDbContext<DbContext, OrderDbContext>();
                r.UsePostgres();
            });

        // Single consumer per business outcome: Completed / Compensating / Failed.
        // See UpdateOrderConsumer.cs for why this replaces the previous four-consumer design.
        x.AddConsumer<UpdateOrderOnCompleted>();
        x.AddConsumer<UpdateOrderOnCompensating>();
        x.AddConsumer<UpdateOrderOnFailed>();

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
    scope.ServiceProvider.GetRequiredService<OrderDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

app.Run();
