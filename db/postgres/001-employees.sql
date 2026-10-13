-- Runs automatically for a new container volume; also usable on the VM.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS public.employees_id_seq
    AS INTEGER START WITH 1 INCREMENT BY 1;
CREATE TABLE IF NOT EXISTS public.employees (
    id INTEGER NOT NULL DEFAULT nextval('public.employees_id_seq'),
    name VARCHAR(255) NOT NULL,
    phone_number VARCHAR(50) NOT NULL,
    address VARCHAR(255) NOT NULL,
    salary NUMERIC(10, 2) NOT NULL,
    CONSTRAINT employees_pkey PRIMARY KEY (id)
);
ALTER SEQUENCE public.employees_id_seq OWNED BY public.employees.id;
COMMIT;
