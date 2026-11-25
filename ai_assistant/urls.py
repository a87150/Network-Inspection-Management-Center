from django.urls import path

from . import views

urlpatterns = [
    path("chat/", views.chat, name="ai_chat"),
    path("history/", views.history, name="ai_history"),
    path("reset/", views.reset, name="ai_reset"),
    path("providers/", views.providers, name="ai_providers"),
    path("providers/save/", views.provider_save, name="ai_provider_save"),
    path("providers/activate/", views.provider_activate, name="ai_provider_activate"),
    path("providers/delete/", views.provider_delete, name="ai_provider_delete"),
    path("retrieve_test/", views.retrieve_test, name="ai_retrieve_test"),
    path("settings/", views.settings_view, name="ai_settings"),
    path("settings/save/", views.settings_save, name="ai_settings_save"),
    path("knowledge/", views.knowledge_list, name="ai_knowledge"),
    path("knowledge/add/", views.knowledge_add, name="ai_knowledge_add"),
    path("knowledge/import/", views.knowledge_import, name="ai_knowledge_import"),
    path("knowledge/delete/", views.knowledge_delete, name="ai_knowledge_delete"),
]
