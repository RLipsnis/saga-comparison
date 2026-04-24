-- Create schemas for each microservice
CREATE SCHEMA IF NOT EXISTS orders;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS shipping;
CREATE SCHEMA IF NOT EXISTS notifications;

-- Safety measure: create temporal schema for Temporal persistence
-- (Temporal auto-setup typically handles its own schema, but this ensures it exists)
CREATE SCHEMA IF NOT EXISTS temporal;
CREATE SCHEMA IF NOT EXISTS temporal_visibility;
