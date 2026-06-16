# Durable Derivative Queue

Pane View keeps a durable derivative queue in Postgres and the media optimizer drains that queue, instead of routing gallery image URLs directly through a synchronous transformation proxy. This preserves private-original boundaries, retries, prewarm, video and future PDF derivative support, and queue diagnostics; those properties are more important for Latch Works than pure request-time transformation simplicity.
