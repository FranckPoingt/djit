"""Add file_mtime, file_size, waveform_data to tracks

Revision ID: add_file_stat_waveform
Revises: add_track_mood_energy
Create Date: 2026-04-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_file_stat_waveform'
down_revision: Union[str, None] = 'add_track_duration_seconds'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tracks', sa.Column('file_mtime', sa.Float(), nullable=True))
    op.add_column('tracks', sa.Column('file_size', sa.Integer(), nullable=True))
    op.add_column('tracks', sa.Column('waveform_data', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('tracks', 'waveform_data')
    op.drop_column('tracks', 'file_size')
    op.drop_column('tracks', 'file_mtime')
