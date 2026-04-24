using Microsoft.EntityFrameworkCore;
using ShippingService.Domain;
using Shared.Infrastructure;

namespace ShippingService.Infrastructure;

public class ShippingDbContext : DbContext
{
    public ShippingDbContext(DbContextOptions<ShippingDbContext> options) : base(options) { }

    public DbSet<Shipment> Shipments => Set<Shipment>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("shipping");

        modelBuilder.Entity<Shipment>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Status).HasConversion<string>();
        });

        modelBuilder.Entity<IdempotencyRecord>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.HasIndex(e => new { e.Key, e.OperationType }).IsUnique();
        });
    }
}
