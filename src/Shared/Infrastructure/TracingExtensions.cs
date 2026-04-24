using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Shared.Infrastructure;

public static class TracingExtensions
{
    public static IServiceCollection AddSagaTracing(this IServiceCollection services, string serviceName)
    {
        services.AddOpenTelemetry()
            .ConfigureResource(r => r.AddService(serviceName))
            .WithTracing(builder =>
            {
                builder
                    .AddAspNetCoreInstrumentation(opts =>
                    {
                        opts.RecordException = true;
                        opts.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health");
                    })
                    .AddHttpClientInstrumentation(opts =>
                    {
                        opts.RecordException = true;
                    })
                    .AddSource("Npgsql")
                    .AddSource("MassTransit")
                    .AddSource("Temporalio")
                    .AddOtlpExporter(opts =>
                    {
                        opts.Endpoint = new Uri("http://localhost:4317");
                    });
            });

        return services;
    }
}
