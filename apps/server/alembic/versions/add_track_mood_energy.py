"""Add mood and energy fields to tracks

Revision ID: add_track_mood_energy
Revises: add_saved_views_table
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_track_mood_energy'
down_revision: Union[str, None] = 'add_saved_views_table'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tracks', sa.Column('mood', sa.String(length=100), nullable=True))
    op.add_column('tracks', sa.Column('energy', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('tracks', 'energy')
    op.drop_column('tracks', 'mood')
