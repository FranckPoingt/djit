"""Track bounded automatic analysis retries.

Revision ID: add_analysis_failures
Revises: add_analysis_batches
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "add_analysis_failures"
down_revision: Union[str, None] = "add_analysis_batches"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tracks",
        sa.Column(
            "analysis_failures",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.execute(
        "UPDATE tracks SET analysis_failures = 1 "
        "WHERE analysis_status = 'failed'"
    )


def downgrade() -> None:
    op.drop_column("tracks", "analysis_failures")
