from __future__ import annotations


def group_duplicates(file_hashes: list[str]) -> dict[str, list[int]]:
    groups: dict[str, list[int]] = {}
    for index, file_hash in enumerate(file_hashes, start=1):
        groups.setdefault(file_hash, []).append(index)
    return groups
