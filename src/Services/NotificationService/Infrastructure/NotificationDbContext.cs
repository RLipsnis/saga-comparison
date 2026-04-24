using Microsoft.EntityFrameworkCore;
using NotificationService.Domain;
using Shared.Infrastructure;

namespace NotificationService.Infrastructure;

public class NotificationDbContext : DbContext
{
    public NotificationDbContext(DbContextOptions<NotificationDbContext> options) : base(options) { }

    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema("notifications");

        modelBuilder.Entity<Notification>(entity =>
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
