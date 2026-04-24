using MassTransit;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace OrderService.Choreography;

public class OrderSagaStateMap : SagaClassMap<OrderSagaState>
{
    protected override void Configure(EntityTypeBuilder<OrderSagaState> entity, ModelBuilder model)
    {
        entity.ToTable("OrderSagaState", "orders");

        entity.Property(x => x.CurrentState).HasMaxLength(64);
        entity.Property(x => x.ItemsJson);
        entity.Property(x => x.TotalAmount).HasPrecision(18, 2);
        entity.Property(x => x.Address).HasMaxLength(500);
        entity.Property(x => x.TrackingNumber).HasMaxLength(50);
        entity.Property(x => x.FailureReason).HasMaxLength(2000);

        entity.Property(x => x.InventoryReservedAt);
        entity.Property(x => x.PaymentProcessedAt);
        entity.Property(x => x.ShippingArrangedAt);
        entity.Property(x => x.NotificationSentAt);
        entity.Property(x => x.CompletedAt);

        entity.Property(x => x.Version).IsConcurrencyToken();
    }
}
