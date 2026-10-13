-- Execute with sqlcmd -v DatabaseName="employeesdb" (or your SQL_DB_NAME).
-- Login/user creation and grants are managed separately by the host administrator.
USE [master];
GO
IF DB_ID(N'$(DatabaseName)') IS NULL
BEGIN
    CREATE DATABASE [$(DatabaseName)];
END;
GO
USE [$(DatabaseName)];
GO
IF OBJECT_ID(N'dbo.employees', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.employees (
        id INT IDENTITY(1, 1) NOT NULL,
        name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(50) NOT NULL,
        address VARCHAR(255) NOT NULL,
        salary DECIMAL(10, 2) NOT NULL,
        CONSTRAINT employees_pkey PRIMARY KEY (id)
    );
END;
GO
