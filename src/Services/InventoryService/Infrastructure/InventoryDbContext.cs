using Microsoft.EntityFrameworkCore;
using InventoryService.Domain;
using Shared.Infrastructure;

namespace InventoryService.Infrastructure;

public class InventoryDbContext : DbContext
{
    public InventoryDbContext(DbContextOptions<InventoryDbContext> options) : base(options) { }

    public DbSet<Product> Products => Set<Product>();
    public DbSet<Reservation> Reservations => Set<Reservation>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("inventory");

        modelBuilder.Entity<Product>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Price).HasPrecision(18, 2);
            entity.Property(e => e.Version).IsRowVersion();

            entity.HasData(
                new Product { Id = Guid.Parse("a1111111-1111-1111-1111-111111111111"), Name = "Wireless Mouse", Sku = "WM-001", Price = 29.99m, StockQuantity = 100_000, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("a2222222-2222-2222-2222-222222222222"), Name = "Mechanical Keyboard", Sku = "MK-001", Price = 89.99m, StockQuantity = 100_000, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("a3333333-3333-3333-3333-333333333333"), Name = "USB-C Hub", Sku = "UH-001", Price = 49.99m, StockQuantity = 100_000, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("a4444444-4444-4444-4444-444444444444"), Name = "Monitor Stand", Sku = "MS-001", Price = 39.99m, StockQuantity = 100_000, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("a5555555-5555-5555-5555-555555555555"), Name = "Webcam HD", Sku = "WC-001", Price = 59.99m, StockQuantity = 100_000, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("b1111111-1111-1111-1111-111111111111"), Name = "Gaming Headset", Sku = "GH-001", Price = 79.99m, StockQuantity = 10, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("b2222222-2222-2222-2222-222222222222"), Name = "Ergonomic Chair", Sku = "EC-001", Price = 299.99m, StockQuantity = 10, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("b3333333-3333-3333-3333-333333333333"), Name = "Desk Lamp", Sku = "DL-001", Price = 34.99m, StockQuantity = 10, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("c1111111-1111-1111-1111-111111111111"), Name = "Limited Edition Tablet", Sku = "LT-001", Price = 999.99m, StockQuantity = 1, ReservedQuantity = 0 },
                new Product { Id = Guid.Parse("d1111111-1111-1111-1111-111111111111"), Name = "Discontinued Cable", Sku = "DC-001", Price = 9.99m, StockQuantity = 0, ReservedQuantity = 0 }
            );
        });

        modelBuilder.Entity<Reservation>(entity =>
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
