from django.urls import path

from . import views

urlpatterns = [
    path("chat/", views.chat, name="ai_chat"),
    path("history/", views.history, name="ai_history"),
    path("reset/", views.reset, name="ai_reset"),
    path("settings/", views.settings_view, name="ai_settings"),
    path("settings/save/", views.settings_save, name="ai_settings_save"),
    path("knowledge/", views.knowledge_list, name="ai_knowledge"),
    path("knowledge/add/", views.knowledge_add, name="ai_knowledge_add"),
    path("knowledge/import/", views.knowledge_import, name="ai_knowledge_import"),
    path("knowledge/delete/", views.knowledge_delete, name="ai_knowledge_delete"),
]
