"""add metadata change batches

Revision ID: add_metadata_change_batches
Revises: rename_review_status_to_triage_decision
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "add_metadata_change_batches"
down_revision: Union[str, None] = "rename_review_status_to_triage_decision"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "metadata_change_batches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("recipe", sa.String(length=64), nullable=False),
        sa.Column("changes_json", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("undone_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("metadata_change_batches")
