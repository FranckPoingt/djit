from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator


class EventBroadcaster:
    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[dict[str, object]]] = []

    async def publish(self, event: dict[str, object]) -> None:
        for subscriber in self._subscribers:
            await subscriber.put(event)

    async def subscribe(self) -> AsyncIterator[dict[str, object]]:
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._subscribers.append(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.remove(queue)


analysis_events = EventBroadcaster()
