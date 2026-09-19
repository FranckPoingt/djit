from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import math
import multiprocessing as mp
import os
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import or_
from sse_starlette.sse import EventSourceResponse

from djit.database.models import AnalysisBatch, Track
from djit.database.session import SessionLocal
from djit.schemas.analysis import AnalysisEvent
from djit.schemas.analysis import (
    AllAnalysisQueueRequest,
    AnalysisBatchResponse,
    AnalysisCandidateResponse,
    AnalysisQueueRequest,
    AnalysisQueueResponse,
    CuratedAnalysisQueueRequest,
    FolderAnalysisQueueRequest,
)
from djit.services.analyzer import analyze_track_path, warm_analysis_runtime
from djit.services.analysis_policy import should_skip_analysis_duration
from djit.worker.events import analysis_events
from djit.worker.queue import (
    cancel_requested,
    clear_queue,
    enqueue_many,
    get_analysis_queue,
    request_cancel,
)

router = APIRouter(tags=["analysis"])
_worker_tasks: set[asyncio.Task[None]] = set()
_watchdog_task: asyncio.Task[None] | None = None
_prewarm_task: asyncio.Task[None] | None = None
_worker_lock = asyncio.Lock()
_session_factory = SessionLocal
logger = logging.getLogger("uvicorn.error")
LEGACY_AUTO_MOODS = {
    "Dark",
    "Deep",
    "Driving",
    "Euphoric",
    "Hypnotic",
    "Peak Time",
    "Uplifting",
    "Warm",
}
ANALYSIS_TIMEOUT_SECONDS = 90
MAX_AUTOMATIC_ANALYSIS_FAILURES = 2
ANALYSIS_EXECUTOR = os.getenv("DJIT_ANALYSIS_EXECUTOR", "process").strip().lower()
ANALYSIS_WORKERS = max(1, int(os.getenv("DJIT_ANALYSIS_WORKERS", "8")))
ANALYSIS_DSP_CONCURRENCY = max(
    1,
    int(os.getenv("DJIT_ANALYSIS_DSP_CONCURRENCY", str(ANALYSIS_WORKERS))),
)
ANALYSIS_POOL_MAX_TASKS_PER_CHILD = max(
    1,
    int(os.getenv("DJIT_ANALYSIS_POOL_MAX_TASKS_PER_CHILD", "16")),
)
STALE_ANALYSIS_SECONDS = max(
    60,
    int(os.getenv("DJIT_ANALYSIS_STALE_SECONDS", "300")),
)
WATCHDOG_INTERVAL_SECONDS = max(
    15,
    int(os.getenv("DJIT_ANALYSIS_WATCHDOG_INTERVAL_SECONDS", "30")),
)
_analysis_dsp_slots = asyncio.Semaphore(ANALYSIS_DSP_CONCURRENCY)
_analysis_process_pool: concurrent.futures.ProcessPoolExecutor | None = None
_active_track_ids: set[int] = set()


def _track_status_event(track: Track, status: str) -> AnalysisEvent:
    return AnalysisEvent(
        track_id=track.id,
        status=status,
        bpm=track.bpm,
        bpm_confidence=track.bpm_confidence,
        key_camelot=track.key_camelot,
        mood=track.mood,
        energy=track.energy,
    )


def _mark_analysis_failed(track: Track) -> None:
    track.analysis_status = "failed"
    track.analysis_failures = (track.analysis_failures or 0) + 1
    track.bpm = None
    track.bpm_confidence = None
    track.key_camelot = "0A"


def _sanitize_for_json(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_for_json(v) for v in value]
    if isinstance(value, tuple):
        return [_sanitize_for_json(v) for v in value]
    return value


def _ensure_analysis_pool() -> concurrent.futures.ProcessPoolExecutor:
    global _analysis_process_pool
    if _analysis_process_pool is None:
        _analysis_process_pool = concurrent.futures.ProcessPoolExecutor(
            max_workers=ANALYSIS_DSP_CONCURRENCY,
            mp_context=mp.get_context("spawn"),
            max_tasks_per_child=ANALYSIS_POOL_MAX_TASKS_PER_CHILD,
        )
        logger.info(
            "analysis pool: created workers=%s max_tasks_per_child=%s",
            ANALYSIS_DSP_CONCURRENCY,
            ANALYSIS_POOL_MAX_TASKS_PER_CHILD,
        )
    return _analysis_process_pool


def _rebuild_analysis_pool() -> None:
    global _analysis_process_pool
    old = _analysis_process_pool
    _analysis_process_pool = concurrent.futures.ProcessPoolExecutor(
        max_workers=ANALYSIS_DSP_CONCURRENCY,
        mp_context=mp.get_context("spawn"),
        max_tasks_per_child=ANALYSIS_POOL_MAX_TASKS_PER_CHILD,
    )
    logger.info(
        "analysis pool: rebuilt workers=%s max_tasks_per_child=%s",
        ANALYSIS_DSP_CONCURRENCY,
        ANALYSIS_POOL_MAX_TASKS_PER_CHILD,
    )
    if old is not None:
        old.shutdown(wait=False, cancel_futures=True)


def set_analysis_session_factory(session_factory) -> None:
    global _session_factory
    _session_factory = session_factory


def _batch_track_ids(batch: AnalysisBatch) -> list[int]:
    try:
        value = json.loads(batch.track_ids_json)
    except (TypeError, json.JSONDecodeError):
        return []
    return [track_id for track_id in value if isinstance(track_id, int)]


def _active_batch(db) -> AnalysisBatch | None:
    return (
        db.query(AnalysisBatch)
        .filter(AnalysisBatch.status.in_(["queued", "running", "paused"]))
        .order_by(AnalysisBatch.id)
        .first()
    )


def _refresh_batch(
    db,
    batch_id: int,
    current_track_id: int | None = None,
    *,
    clear_current: bool = False,
) -> None:
    batch = db.query(AnalysisBatch).filter(AnalysisBatch.id == batch_id).first()
    if not batch:
        return

    track_ids = _batch_track_ids(batch)
    statuses = [
        status
        for (status,) in db.query(Track.analysis_status)
        .filter(Track.id.in_(track_ids))
        .all()
    ] if track_ids else []
    batch.failed = statuses.count("failed")
    batch.skipped = statuses.count("skipped")
    batch.completed = sum(
        status in {"done", "overridden", "failed", "skipped"}
        for status in statuses
    )
    batch.updated_at = datetime.utcnow()

    if batch.status != "cancelled" and batch.completed >= batch.total:
        batch.status = "completed"
        batch.current_track_id = None
        batch.finished_at = datetime.utcnow()
    elif batch.status == "paused":
        if clear_current:
            batch.current_track_id = None
    elif batch.status != "cancelled":
        if current_track_id is not None:
            batch.status = "running"
            batch.current_track_id = current_track_id
        elif clear_current or batch.current_track_id is None:
            batch.status = "queued"
            batch.current_track_id = None
        if batch.started_at is None and current_track_id is not None:
            batch.started_at = datetime.utcnow()
    db.commit()


def _batch_response(db, batch: AnalysisBatch) -> AnalysisBatchResponse:
    now = batch.finished_at or datetime.utcnow()
    started_at = batch.started_at or batch.created_at
    elapsed = max(0, round((now - started_at).total_seconds()))
    analyzed = max(0, batch.completed - batch.skipped)
    remaining = max(0, batch.total - batch.completed)
    eta = round((elapsed / analyzed) * remaining) if analyzed > 0 and remaining > 0 else None
    current_title = None
    current_artist = None
    if batch.current_track_id is not None:
        current_track = (
            db.query(Track.title, Track.artist)
            .filter(Track.id == batch.current_track_id)
            .first()
        )
        if current_track:
            current_title, current_artist = current_track
    return AnalysisBatchResponse(
        id=batch.id,
        mode=batch.mode,
        scope=batch.scope,
        status=batch.status,
        total=batch.total,
        completed=batch.completed,
        failed=batch.failed,
        skipped=batch.skipped,
        current_track_id=batch.current_track_id,
        current_track_title=current_title,
        current_track_artist=current_artist,
        elapsed_seconds=elapsed,
        eta_seconds=eta,
        created_at=batch.created_at,
        started_at=batch.started_at,
        finished_at=batch.finished_at,
    )


async def _process_analysis(batch_id: int, track_id: int, mode: str) -> None:
    logger.info("analysis: start batch_id=%s track_id=%s mode=%s", batch_id, track_id, mode)
    _active_track_ids.add(track_id)
    db = _session_factory()
    try:
        track = db.query(Track).filter(Track.id == track_id).first()
        if not track:
            await analysis_events.publish(
                AnalysisEvent(track_id=track_id, status="failed").model_dump()
            )
            return

        if track.analysis_status == "overridden":
            logger.info("analysis: skip overridden track_id=%s", track_id)
            await analysis_events.publish(
                AnalysisEvent(
                    track_id=track_id,
                    status="done",
                    bpm=track.bpm,
                    bpm_confidence=track.bpm_confidence,
                    key_camelot=track.key_camelot,
                    mood=track.mood,
                    energy=track.energy,
                ).model_dump()
            )
            return

        if not Path(track.path).exists():
            logger.warning("analysis: missing file track_id=%s path=%s", track_id, track.path)
            _mark_analysis_failed(track)
            db.commit()
            await analysis_events.publish(
                AnalysisEvent(
                    track_id=track_id,
                    status="failed",
                    bpm=None,
                    bpm_confidence=None,
                    key_camelot="0A",
                ).model_dump()
            )
            return

        if should_skip_analysis_duration(track.duration_seconds):
            track.analysis_status = "skipped"
            db.commit()
            await analysis_events.publish(
                _track_status_event(track, "skipped").model_dump()
            )
            logger.info(
                "analysis: skipped long track_id=%s duration_seconds=%s",
                track_id,
                track.duration_seconds,
            )
            return

        track.analysis_status = "analyzing"
        db.commit()
        await analysis_events.publish(
            AnalysisEvent(track_id=track_id, status="analyzing").model_dump()
        )

        if cancel_requested():
            track.analysis_status = "pending"
            db.commit()
            await analysis_events.publish(
                AnalysisEvent(track_id=track_id, status="pending").model_dump()
            )
            return

        async with _analysis_dsp_slots:
            try:
                if ANALYSIS_EXECUTOR == "thread":
                    logger.info("analysis: submitted to thread track_id=%s", track_id)
                    result = await asyncio.wait_for(
                        asyncio.to_thread(analyze_track_path, track_id, track.path, mode),
                        timeout=ANALYSIS_TIMEOUT_SECONDS + 20,
                    )
                else:
                    pool = _ensure_analysis_pool()
                    loop = asyncio.get_running_loop()
                    logger.info("analysis: submitted to pool track_id=%s", track_id)
                    result = await asyncio.wait_for(
                        loop.run_in_executor(
                            pool,
                            analyze_track_path,
                            track_id,
                            track.path,
                            mode,
                        ),
                        timeout=ANALYSIS_TIMEOUT_SECONDS + 20,
                    )
            except concurrent.futures.process.BrokenProcessPool:
                logger.error("analysis: process pool broken track_id=%s, rebuilding", track_id)
                _rebuild_analysis_pool()
                raise
        if result.status == "failed":
            _mark_analysis_failed(track)
        else:
            track.analysis_failures = 0
            track.bpm = result.bpm
            track.bpm_confidence = result.bpm_confidence
            track.key_camelot = result.key_camelot
            if track.mood in LEGACY_AUTO_MOODS:
                track.mood = None
                track.energy = result.energy
            else:
                if track.mood is None and result.mood is not None:
                    track.mood = result.mood
                if track.energy is None and result.energy is not None:
                    track.energy = result.energy
            track.analysis_status = result.status
        db.commit()
        await analysis_events.publish(result.model_dump())
        logger.info("analysis: completed track_id=%s status=%s", track_id, result.status)
    except TimeoutError:
        logger.warning("analysis: timeout track_id=%s", track_id)
        track = db.query(Track).filter(Track.id == track_id).first()
        if track:
            _mark_analysis_failed(track)
            db.commit()
        await analysis_events.publish(
            AnalysisEvent(
                track_id=track_id,
                status="failed",
                bpm=None,
                bpm_confidence=None,
                key_camelot="0A",
            ).model_dump()
        )
        if ANALYSIS_EXECUTOR == "thread":
            logger.warning("analysis: restarting backend after native timeout")
            os._exit(75)
    except Exception:
        logger.exception("analysis: failed track_id=%s", track_id)
        track = db.query(Track).filter(Track.id == track_id).first()
        if track:
            _mark_analysis_failed(track)
            db.commit()
        await analysis_events.publish(
            AnalysisEvent(
                track_id=track_id,
                status="failed",
                bpm=None,
                bpm_confidence=None,
                key_camelot="0A",
            ).model_dump()
        )
    finally:
        _active_track_ids.discard(track_id)
        try:
            _refresh_batch(db, batch_id, clear_current=True)
        except Exception:
            logger.exception("analysis batch: refresh failed batch_id=%s", batch_id)
        db.close()


async def _analysis_worker() -> None:
    current_task = asyncio.current_task()
    worker_name = current_task.get_name() if current_task is not None else "worker"
    logger.info("analysis worker: started name=%s", worker_name)
    while True:
        try:
            analysis_queue = get_analysis_queue()
            _, _, batch_id, track_id, mode = await analysis_queue.get()
        except asyncio.CancelledError:
            logger.info("analysis worker: cancelled name=%s", worker_name)
            break
        try:
            logger.info(
                "analysis worker: dequeued name=%s batch_id=%s track_id=%s mode=%s",
                worker_name,
                batch_id,
                track_id,
                mode,
            )
            db = _session_factory()
            try:
                batch = db.query(AnalysisBatch).filter(AnalysisBatch.id == batch_id).first()
                if not batch or batch.status in {"paused", "cancelled", "completed"}:
                    continue
                track_status = db.query(Track.analysis_status).filter(Track.id == track_id).scalar()
                if track_id in _active_track_ids or track_status != "pending":
                    continue
                _refresh_batch(db, batch_id, track_id)
            finally:
                db.close()
            await _process_analysis(batch_id, track_id, mode)
        finally:
            analysis_queue.task_done()


def _recover_stale_tracks() -> list[int]:
    db = _session_factory()
    try:
        cutoff = datetime.utcnow() - timedelta(seconds=STALE_ANALYSIS_SECONDS)
        stale_tracks = (
            db.query(Track)
            .filter(Track.analysis_status == "analyzing")
            .filter(Track.updated_at < cutoff)
            .all()
        )

        if not stale_tracks:
            return []

        recovered_ids: list[int] = []
        for track in stale_tracks:
            _mark_analysis_failed(track)
            recovered_ids.append(track.id)

        db.commit()
        return recovered_ids
    finally:
        db.close()


async def _analysis_watchdog() -> None:
    logger.info(
        "analysis watchdog: started interval=%ss stale_after=%ss",
        WATCHDOG_INTERVAL_SECONDS,
        STALE_ANALYSIS_SECONDS,
    )
    while True:
        try:
            await asyncio.sleep(WATCHDOG_INTERVAL_SECONDS)
            recovered_ids = _recover_stale_tracks()
            for track_id in recovered_ids:
                logger.warning("analysis watchdog: recovered stale track_id=%s", track_id)
                await analysis_events.publish(
                    AnalysisEvent(track_id=track_id, status="failed").model_dump()
                )
        except asyncio.CancelledError:
            logger.info("analysis watchdog: cancelled")
            break
        except Exception:
            logger.exception("analysis watchdog: sweep failed")


async def _prewarm_analysis_runtime() -> None:
    async with _analysis_dsp_slots:
        logger.info("analysis runtime: prewarming")
        await asyncio.to_thread(warm_analysis_runtime)
        logger.info("analysis runtime: ready")


async def _ensure_worker_running() -> None:
    global _watchdog_task
    async with _worker_lock:
        # Drop completed tasks first.
        stale_tasks = {task for task in _worker_tasks if task.done()}
        _worker_tasks.difference_update(stale_tasks)

        missing = ANALYSIS_WORKERS - len(_worker_tasks)
        for _ in range(max(0, missing)):
            worker_index = len(_worker_tasks) + 1
            task = asyncio.create_task(
                _analysis_worker(),
                name=f"analysis-worker-{worker_index}",
            )
            _worker_tasks.add(task)

        if missing > 0:
            logger.info(
                "analysis worker: pool ready workers=%s dsp=%s",
                len(_worker_tasks),
                ANALYSIS_DSP_CONCURRENCY,
            )

        if _watchdog_task is None or _watchdog_task.done():
            _watchdog_task = asyncio.create_task(
                _analysis_watchdog(),
                name="analysis-watchdog",
            )


async def start_analysis_worker() -> None:
    global _prewarm_task
    resumable: list[tuple[int, list[int], str]] = []
    db = _session_factory()
    try:
        active_batches = (
            db.query(AnalysisBatch)
            .filter(AnalysisBatch.status.in_(["queued", "running"]))
            .order_by(AnalysisBatch.id)
            .all()
        )
        owned_ids: set[int] = set()
        for batch in active_batches:
            track_ids = _batch_track_ids(batch)
            owned_ids.update(track_ids)
            tracks = db.query(Track).filter(Track.id.in_(track_ids)).all()
            queued_ids: list[int] = []
            for track in tracks:
                if track.analysis_status == "analyzing":
                    track.analysis_status = "pending"
                if track.analysis_status == "pending":
                    queued_ids.append(track.id)
            batch.status = "queued"
            batch.current_track_id = None
            batch.started_at = datetime.utcnow()
            batch.finished_at = None
            batch.updated_at = datetime.utcnow()
            if queued_ids:
                resumable.append((batch.id, queued_ids, batch.mode))

        orphaned = db.query(Track).filter(
            Track.analysis_status.in_(["pending", "analyzing"])
        )
        if owned_ids:
            orphaned = orphaned.filter(~Track.id.in_(owned_ids))
        orphaned.update(
            {Track.analysis_status: "not_analyzed"},
            synchronize_session=False,
        )
        db.commit()
    finally:
        db.close()
    await _ensure_worker_running()
    if _prewarm_task is None or _prewarm_task.done():
        _prewarm_task = asyncio.create_task(
            _prewarm_analysis_runtime(),
            name="analysis-prewarm",
        )
    for batch_id, track_ids, mode in resumable:
        await enqueue_many(batch_id, track_ids, mode)


async def stop_analysis_worker() -> None:
    global _watchdog_task, _prewarm_task, _analysis_process_pool
    async with _worker_lock:
        tasks = list(_worker_tasks)
        _worker_tasks.clear()

        for task in tasks:
            if not task.done():
                task.cancel()

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        if _watchdog_task is not None and not _watchdog_task.done():
            _watchdog_task.cancel()
            await asyncio.gather(_watchdog_task, return_exceptions=True)
        _watchdog_task = None

        if _prewarm_task is not None and not _prewarm_task.done():
            _prewarm_task.cancel()
            await asyncio.gather(_prewarm_task, return_exceptions=True)
        _prewarm_task = None

        if _analysis_process_pool is not None:
            _analysis_process_pool.shutdown(wait=False, cancel_futures=True)
            _analysis_process_pool = None
        await clear_queue()


async def _enqueue_analysis(payload: AnalysisQueueRequest) -> AnalysisQueueResponse:
    await _ensure_worker_running()

    requested_ids = list(dict.fromkeys(payload.track_ids))
    if not requested_ids:
        logger.info("analysis queue: no track ids requested")
        return AnalysisQueueResponse(
            batch_id=None,
            requested=0,
            queued=0,
            skipped=0,
            queued_track_ids=[],
            skipped_track_ids=[],
        )

    queued_ids: list[int] = []
    promoted_ids: list[int] = []
    skipped_ids: list[int] = []
    skipped_events: list[dict[str, object | None]] = []
    batch_id: int | None = None
    batch_paused = False
    db = _session_factory()
    try:
        batch = _active_batch(db)
        if batch and batch.mode != payload.mode and payload.priority != "review":
            raise HTTPException(
                status_code=409,
                detail=f"A {batch.mode} analysis batch is already active.",
            )
        existing_batch_ids = set(_batch_track_ids(batch)) if batch else set()
        tracks = db.query(Track).filter(Track.id.in_(requested_ids)).all()
        track_by_id = {track.id: track for track in tracks}

        for track_id in requested_ids:
            if track_id in existing_batch_ids:
                track = track_by_id.get(track_id)
                if (
                    payload.priority == "review"
                    and track is not None
                    and track.analysis_status == "pending"
                ):
                    promoted_ids.append(track_id)
                continue
            track = track_by_id.get(track_id)
            if not track:
                continue
            if track.analysis_status == "overridden":
                continue
            if should_skip_analysis_duration(track.duration_seconds):
                skipped_ids.append(track_id)
                if track.analysis_status != "skipped":
                    track.analysis_status = "skipped"
                    skipped_events.append(_track_status_event(track, "skipped").model_dump())
                continue
            if track.analysis_status == "analyzing":
                if track_id in _active_track_ids:
                    continue

                logger.warning(
                    "analysis queue: reclaim orphan analyzing track_id=%s",
                    track_id,
                )

            if (
                not payload.force_reanalyze
                and track.analysis_status == "done"
                and track.triage_decision != "problem"
            ):
                continue

            track.analysis_status = "pending"
            queued_ids.append(track_id)

        batch_track_ids = [*queued_ids, *skipped_ids]
        if batch_track_ids:
            if batch is None:
                batch = AnalysisBatch(
                    mode=payload.mode,
                    scope=payload.scope,
                    status="queued" if queued_ids else "completed",
                    track_ids_json=json.dumps(batch_track_ids),
                    total=len(batch_track_ids),
                    completed=len(skipped_ids),
                    skipped=len(skipped_ids),
                    finished_at=datetime.utcnow() if not queued_ids else None,
                )
                db.add(batch)
                db.flush()
            else:
                combined_ids = [*_batch_track_ids(batch), *batch_track_ids]
                batch.track_ids_json = json.dumps(combined_ids)
                batch.total = len(combined_ids)
                batch.updated_at = datetime.utcnow()
            batch_id = batch.id
            batch_paused = batch.status == "paused"
            db.commit()
            _refresh_batch(db, batch.id)
        elif batch is not None:
            batch_id = batch.id
    finally:
        db.close()

    for event in skipped_events:
        await analysis_events.publish(event)

    for track_id in queued_ids:
        await analysis_events.publish(
            AnalysisEvent(track_id=track_id, status="pending").model_dump()
        )

    enqueued_ids = [*promoted_ids, *queued_ids]
    if batch_id is not None and not batch_paused:
        await enqueue_many(batch_id, enqueued_ids, payload.mode, payload.priority)
    logger.info(
        "analysis queue: requested=%s queued=%s skipped=%s",
        len(requested_ids),
        len(enqueued_ids),
        len(skipped_ids),
    )
    return AnalysisQueueResponse(
        batch_id=batch_id,
        requested=len(requested_ids),
        queued=len(enqueued_ids),
        skipped=len(skipped_ids),
        queued_track_ids=enqueued_ids,
        skipped_track_ids=skipped_ids,
    )


@router.post("/analysis/queue", response_model=AnalysisQueueResponse)
async def enqueue_analysis(payload: AnalysisQueueRequest) -> AnalysisQueueResponse:
    return await _enqueue_analysis(payload)


@router.post("/analysis/queue/folder", response_model=AnalysisQueueResponse)
async def enqueue_folder_analysis(
    payload: FolderAnalysisQueueRequest,
) -> AnalysisQueueResponse:
    normalized_folder = payload.folder_path.rstrip(os.sep)
    db = _session_factory()
    try:
        query = (
            db.query(Track.id)
            .filter(
                or_(
                    Track.path == normalized_folder,
                    Track.path.startswith(
                        f"{normalized_folder}{os.sep}", autoescape=True
                    ),
                )
            )
            .filter(Track.analysis_status.in_(["not_analyzed", "failed"]))
            .filter(
                or_(
                    Track.analysis_status != "failed",
                    Track.analysis_failures < MAX_AUTOMATIC_ANALYSIS_FAILURES,
                )
            )
            .order_by(Track.id)
        )
        if payload.scope == "keep_maybe":
            query = query.filter(Track.triage_decision.in_(["keep", "maybe"]))
        track_ids = [track_id for (track_id,) in query.limit(payload.limit).all()]
    finally:
        db.close()

    return await _enqueue_analysis(
        AnalysisQueueRequest(
            track_ids=track_ids,
            mode=payload.mode,
            scope="folder",
            priority="background",
        )
    )


@router.post("/analysis/queue/curated", response_model=AnalysisQueueResponse)
async def enqueue_curated_analysis(
    payload: CuratedAnalysisQueueRequest,
) -> AnalysisQueueResponse:
    db = _session_factory()
    try:
        track_ids = [
            track_id
            for (track_id,) in db.query(Track.id)
            .filter(Track.triage_decision.in_(["keep", "maybe"]))
            .filter(Track.analysis_status.in_(["not_analyzed", "failed", "skipped"]))
            .filter(
                or_(
                    Track.analysis_status != "failed",
                    Track.analysis_failures < MAX_AUTOMATIC_ANALYSIS_FAILURES,
                )
            )
            .order_by(Track.id)
            .limit(payload.limit)
            .all()
        ]
    finally:
        db.close()
    return await _enqueue_analysis(
        AnalysisQueueRequest(
            track_ids=track_ids,
            mode=payload.mode,
            scope="saved_shortlisted",
            priority="background",
        )
    )


@router.post("/analysis/queue/all", response_model=AnalysisQueueResponse)
async def enqueue_all_analysis(
    payload: AllAnalysisQueueRequest,
) -> AnalysisQueueResponse:
    db = _session_factory()
    try:
        track_ids = [
            track_id
            for (track_id,) in db.query(Track.id)
            .filter(Track.analysis_status.in_(["not_analyzed", "failed", "skipped"]))
            .filter(
                or_(
                    Track.analysis_status != "failed",
                    Track.analysis_failures < MAX_AUTOMATIC_ANALYSIS_FAILURES,
                )
            )
            .order_by(Track.id)
            .limit(payload.limit)
            .all()
        ]
    finally:
        db.close()
    return await _enqueue_analysis(
        AnalysisQueueRequest(
            track_ids=track_ids,
            mode=payload.mode,
            scope="all",
            priority="background",
        )
    )


@router.post("/analysis/queue/background", response_model=AnalysisQueueResponse)
async def enqueue_background_analysis(
    payload: AllAnalysisQueueRequest,
) -> AnalysisQueueResponse:
    if _prewarm_task is not None and not _prewarm_task.done():
        await asyncio.shield(_prewarm_task)
    db = _session_factory()
    try:
        new_query = db.query(Track.id).filter(Track.analysis_status == "not_analyzed")
        legacy_query = db.query(Track.id).filter(
            Track.analysis_status == "done",
            Track.mood.in_(LEGACY_AUTO_MOODS),
        )
        retry_query = db.query(Track.id).filter(
            Track.analysis_status == "failed",
            Track.analysis_failures < MAX_AUTOMATIC_ANALYSIS_FAILURES,
        )
        new_count = new_query.count()
        legacy_count = legacy_query.count()
        retry_count = retry_query.count()
        total_count = new_count + legacy_count
        retry_limit = min(
            retry_count,
            payload.limit
            if total_count == 0
            else min(payload.limit - 1, max(1, payload.limit // 5)),
        )
        normal_limit = payload.limit - retry_limit
        new_limit = (
            min(new_count, max(1, round(normal_limit * new_count / total_count)))
            if new_count and total_count
            else 0
        )
        legacy_limit = min(legacy_count, normal_limit - new_limit)
        if legacy_count and legacy_limit == 0:
            legacy_limit = 1
            new_limit = max(0, new_limit - 1)
        track_ids = [
            track_id
            for (track_id,) in new_query.order_by(Track.id).limit(new_limit).all()
        ] + [
            track_id
            for (track_id,) in legacy_query.order_by(Track.id).limit(legacy_limit).all()
        ] + [
            track_id
            for (track_id,) in retry_query.order_by(Track.id).limit(retry_limit).all()
        ]
    finally:
        db.close()
    return await _enqueue_analysis(
        AnalysisQueueRequest(
            track_ids=track_ids,
            force_reanalyze=True,
            mode=payload.mode,
            scope="all",
            priority="background",
        )
    )


@router.post("/analysis/queue/problem")
async def enqueue_problem_analysis(limit: int | None = None) -> dict[str, int | list[int]]:
    db = _session_factory()
    try:
        query = (
            db.query(Track)
            .filter(Track.triage_decision == "problem")
            .filter(Track.analysis_status != "overridden")
            .order_by(Track.updated_at.desc())
        )
        if limit is not None and limit > 0:
            query = query.limit(limit)

        track_ids = [track.id for track in query.all()]
    finally:
        db.close()
    result = await _enqueue_analysis(
        AnalysisQueueRequest(
            track_ids=track_ids,
            force_reanalyze=True,
            mode="deep",
            scope="issues",
        )
    )
    return {"queued": result.queued, "queued_track_ids": result.queued_track_ids}


@router.get("/analysis/candidates", response_model=AnalysisCandidateResponse)
async def analysis_candidates(
    scope: str = Query(pattern="^(all|saved_shortlisted|folder)$"),
    folder_path: str | None = None,
    mode: str = Query(default="fast", pattern="^(fast|deep)$"),
) -> AnalysisCandidateResponse:
    db = _session_factory()
    try:
        query = db.query(Track).filter(
            Track.analysis_status.in_(["not_analyzed", "failed", "skipped"])
        ).filter(
            or_(
                Track.analysis_status != "failed",
                Track.analysis_failures < MAX_AUTOMATIC_ANALYSIS_FAILURES,
            )
        )
        if scope == "all":
            pass
        elif scope == "saved_shortlisted":
            query = query.filter(Track.triage_decision.in_(["keep", "maybe"]))
        elif folder_path:
            normalized_folder = folder_path.rstrip(os.sep)
            query = query.filter(
                or_(
                    Track.path == normalized_folder,
                    Track.path.startswith(f"{normalized_folder}{os.sep}", autoescape=True),
                )
            )
        else:
            return AnalysisCandidateResponse(count=0, estimated_seconds=0)
        count = query.count()
    finally:
        db.close()
    return AnalysisCandidateResponse(
        count=count,
        estimated_seconds=round(count * (2.5 if mode == "fast" else 4.9)),
    )


@router.get("/analysis/batch", response_model=AnalysisBatchResponse | None)
async def get_analysis_batch() -> AnalysisBatchResponse | None:
    db = _session_factory()
    try:
        batch = db.query(AnalysisBatch).order_by(AnalysisBatch.id.desc()).first()
        return _batch_response(db, batch) if batch else None
    finally:
        db.close()


@router.post("/analysis/batch/pause", response_model=AnalysisBatchResponse)
async def pause_analysis_batch() -> AnalysisBatchResponse:
    db = _session_factory()
    try:
        batch = _active_batch(db)
        if not batch:
            raise HTTPException(status_code=404, detail="No active analysis batch.")
        batch.status = "paused"
        batch.updated_at = datetime.utcnow()
        db.commit()
        await clear_queue()
        return _batch_response(db, batch)
    finally:
        db.close()


@router.post("/analysis/batch/resume", response_model=AnalysisBatchResponse)
async def resume_analysis_batch() -> AnalysisBatchResponse:
    db = _session_factory()
    try:
        batch = (
            db.query(AnalysisBatch)
            .filter(AnalysisBatch.status == "paused")
            .order_by(AnalysisBatch.id.desc())
            .first()
        )
        if not batch:
            raise HTTPException(status_code=404, detail="No paused analysis batch.")
        track_ids = _batch_track_ids(batch)
        queued_ids = [
            track_id
            for (track_id,) in db.query(Track.id)
            .filter(Track.id.in_(track_ids))
            .filter(Track.analysis_status == "pending")
            .all()
        ]
        batch.status = "queued"
        batch.current_track_id = None
        batch.updated_at = datetime.utcnow()
        db.commit()
        await enqueue_many(batch.id, queued_ids, batch.mode)
        return _batch_response(db, batch)
    finally:
        db.close()


@router.delete("/analysis/queue")
async def cancel_analysis_queue() -> dict[str, str]:
    request_cancel()
    await clear_queue()
    db = _session_factory()
    try:
        batch = _active_batch(db)
        if batch:
            track_ids = _batch_track_ids(batch)
            db.query(Track).filter(Track.id.in_(track_ids)).filter(
                Track.analysis_status == "pending"
            ).update(
                {Track.analysis_status: "not_analyzed"},
                synchronize_session=False,
            )
            batch.status = "cancelled"
            batch.current_track_id = None
            batch.finished_at = datetime.utcnow()
            batch.updated_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
    return {"status": "cancelled"}


@router.get("/events/analysis")
async def stream_analysis_events() -> EventSourceResponse:
    async def event_generator():
        async for event in analysis_events.subscribe():
            # Serialize payload explicitly so browser EventSource clients receive valid JSON.
            payload = _sanitize_for_json(event)
            yield {
                "event": "analysis",
                "data": json.dumps(payload, allow_nan=False),
            }

    return EventSourceResponse(
        event_generator(),
        headers={"Content-Encoding": "identity"},
    )
