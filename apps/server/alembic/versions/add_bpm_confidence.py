"""Add bpm_confidence field to tracks

Revision ID: add_bpm_confidence
Revises: 87330801fafe
Create Date: 2026-04-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'add_bpm_confidence'
down_revision: Union[str, None] = '87330801fafe'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tracks', sa.Column('bpm_confidence', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('tracks', 'bpm_confidence')
