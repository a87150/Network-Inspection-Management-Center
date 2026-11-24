from django.urls import path

from . import views

urlpatterns = [
    path("chat/", views.chat, name="ai_chat"),
    path("history/", views.history, name="ai_history"),
    path("reset/", views.reset, name="ai_reset"),
]
