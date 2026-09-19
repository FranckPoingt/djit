"""Rename review status to triage decision.

Revision ID: rename_review_status_to_triage_decision
Revises: add_file_stat_waveform
Create Date: 2026-06-06 16:38:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "rename_review_status_to_triage_decision"
down_revision: Union[str, None] = "add_file_stat_waveform"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tracks",
        sa.Column(
            "triage_decision",
            sa.String(length=32),
            nullable=False,
            server_default="unheard",
        ),
    )
    op.execute("UPDATE tracks SET triage_decision = 'unheard'")
    op.execute("DELETE FROM saved_views")

    with op.batch_alter_table("tracks") as batch_op:
        batch_op.drop_column("review_status")

    with op.batch_alter_table("tracks") as batch_op:
        batch_op.alter_column("triage_decision", server_default=None)


def downgrade() -> None:
    op.add_column(
        "tracks",
        sa.Column(
            "review_status",
            sa.String(length=32),
            nullable=False,
            server_default="unreviewed",
        ),
    )
    op.execute("UPDATE tracks SET review_status = 'unreviewed'")
    op.execute("DELETE FROM saved_views")

    with op.batch_alter_table("tracks") as batch_op:
        batch_op.drop_column("triage_decision")

    with op.batch_alter_table("tracks") as batch_op:
        batch_op.alter_column("review_status", server_default=None)
