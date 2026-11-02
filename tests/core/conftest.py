import pytest

from coffeegrindsize_core import analysis as new_analysis


@pytest.fixture
def legacy_polygon_edges(monkeypatch):
    """The e299811 reference never closed the polygon's last edge for edge rejection."""
    monkeypatch.setattr(new_analysis, "CLOSE_POLYGON_EDGES", False)
