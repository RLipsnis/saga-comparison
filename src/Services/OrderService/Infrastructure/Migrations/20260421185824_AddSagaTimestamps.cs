using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace OrderService.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddSagaTimestamps : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "CompletedAt",
                schema: "orders",
                table: "OrderSagaState",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "InventoryReservedAt",
                schema: "orders",
                table: "OrderSagaState",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "NotificationSentAt",
                schema: "orders",
                table: "OrderSagaState",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "PaymentProcessedAt",
                schema: "orders",
                table: "OrderSagaState",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ShippingArrangedAt",
                schema: "orders",
                table: "OrderSagaState",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CompletedAt",
                schema: "orders",
                table: "OrderSagaState");

            migrationBuilder.DropColumn(
                name: "InventoryReservedAt",
                schema: "orders",
                table: "OrderSagaState");

            migrationBuilder.DropColumn(
                name: "NotificationSentAt",
                schema: "orders",
                table: "OrderSagaState");

            migrationBuilder.DropColumn(
                name: "PaymentProcessedAt",
                schema: "orders",
                table: "OrderSagaState");

            migrationBuilder.DropColumn(
                name: "ShippingArrangedAt",
                schema: "orders",
                table: "OrderSagaState");
        }
    }
}
