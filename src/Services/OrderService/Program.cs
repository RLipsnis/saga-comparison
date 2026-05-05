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
    // Named HttpClients for downstream services (orchestration uses REST).
    // URLs come from config so the bare-metal default (localhost) and the Docker
    // override (Services__Inventory=http://inventory-service:5011 etc.) both work.
    var inventoryUrl    = builder.Configuration["Services:Inventory"]    ?? "http://localhost:5011";
    var paymentUrl      = builder.Configuration["Services:Payment"]      ?? "http://localhost:5012";
    var shippingUrl     = builder.Configuration["Services:Shipping"]     ?? "http://localhost:5013";
    var notificationUrl = builder.Configuration["Services:Notification"] ?? "http://localhost:5014";

    builder.Services.AddHttpClient("InventoryService",    c => c.BaseAddress = new Uri(inventoryUrl));
    builder.Services.AddHttpClient("PaymentService",      c => c.BaseAddress = new Uri(paymentUrl));
    builder.Services.AddHttpClient("ShippingService",     c => c.BaseAddress = new Uri(shippingUrl));
    builder.Services.AddHttpClient("NotificationService", c => c.BaseAddress = new Uri(notificationUrl));

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
    scope.ServiceProvider.GetRequiredService<OrderDbContext>().Database.Migrate();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { Status = "OK", SagaMode = sagaMode }));

app.Run();
