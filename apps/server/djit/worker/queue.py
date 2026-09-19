from __future__ import annotations

import asyncio
from itertools import count


AnalysisQueueItem = tuple[int, int, int, int, str]
_analysis_queue: asyncio.PriorityQueue[AnalysisQueueItem] | None = None
_analysis_queue_loop: asyncio.AbstractEventLoop | None = None
_analysis_queue_sequence = count()
_cancel_requested = False
_PRIORITIES = {"review": 0, "normal": 10, "background": 20}


def get_analysis_queue() -> asyncio.PriorityQueue[AnalysisQueueItem]:
    global _analysis_queue, _analysis_queue_loop
    loop = asyncio.get_running_loop()
    if _analysis_queue is None or _analysis_queue_loop is not loop:
        _analysis_queue = asyncio.PriorityQueue()
        _analysis_queue_loop = loop
    return _analysis_queue


async def enqueue_many(
    batch_id: int,
    track_ids: list[int],
    mode: str,
    priority: str = "normal",
) -> None:
    global _cancel_requested
    _cancel_requested = False
    for track_id in track_ids:
        await get_analysis_queue().put(
            (_PRIORITIES[priority], next(_analysis_queue_sequence), batch_id, track_id, mode)
        )


async def clear_queue() -> None:
    analysis_queue = get_analysis_queue()
    while not analysis_queue.empty():
        analysis_queue.get_nowait()
        analysis_queue.task_done()


def request_cancel() -> None:
    global _cancel_requested
    _cancel_requested = True


def cancel_requested() -> bool:
    return _cancel_requested
