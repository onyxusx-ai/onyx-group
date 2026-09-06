-- Сначала остановить запись и сделать D1 bookmark/export.
DROP TABLE IF EXISTS shipments;
DROP TABLE IF EXISTS payment_records;

-- Добавленные колонки customers/orders/suppliers намеренно остаются: это безопасный
-- совместимый откат D1. Старый Worker их игнорирует, а DROP COLUMN потребовал бы
-- перестройки таблиц и создавал лишний риск потери данных.
