"""Add duration_seconds field to tracks

Revision ID: add_track_duration_seconds
Revises: add_track_mood_energy
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_track_duration_seconds'
down_revision: Union[str, None] = 'add_track_mood_energy'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tracks', sa.Column('duration_seconds', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('tracks', 'duration_seconds')
