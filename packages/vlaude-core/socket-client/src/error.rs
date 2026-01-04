//! Socket 错误定义

use thiserror::Error;

#[derive(Error, Debug)]
pub enum SocketError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Not connected")]
    NotConnected,

    #[error("Emit failed: {0}")]
    EmitFailed(String),

    #[error("Ack timeout")]
    AckTimeout,

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("TLS error: {0}")]
    TlsError(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Registry error: {0}")]
    RegistryError(String),
}
